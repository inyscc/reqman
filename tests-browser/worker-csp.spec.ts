// 核实 blob Worker 是否继承主文档的 CSP（任务 1.3）。
//
// 为什么这条决定方案：脚本沙箱跑在 uvm 用 `new Worker(blobURL)` 建起来的专用 Worker
// 里，与应用同源（见 design.md 的 Context —— uvm 的浏览器后端）。CSP 的 `connect-src`
// 是「沙箱一旦被逃逸，数据仍然发不出去」的最后一道墙（design.md D3）。如果 blob Worker
// 不继承文档 CSP，这道墙就不存在，方案必须改走跨源沙箱。
//
// 这里的 CSP 直接从 `src-tauri/tauri.conf.json` 读取，而不是在测试里另写一份：配置被
// 放松时用例必须跟着变红，否则它只是在验证一份与产品无关的字符串。
//
// 每个「什么都没发生」的断言都配一个正对照——同样的探针、只放宽对应指令后必须成功，
// 用来证明「计数为 0」是真的被拦，而不是探针根本没跑起来。

import type { Browser } from 'playwright';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

/** 应用真实配置的 CSP。 */
const APP_CSP = (
  JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { security: { csp: string } } }
).app.security.csp;

/** 把「被请求过的路径」记下来的极简 HTTP 服务。 */
interface Recorder {
  origin: string;
  seen: string[];
  reset: () => void;
  close: () => Promise<void>;
}

async function startRecorder(): Promise<Recorder> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
    res.end('/* 探针目标 */');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    reset: () => {
      seen.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 承载页脚本：把 workerSource 装进 blob Worker，并把 worker 的消息收集起来。 */
function hostScript(workerSource: string): string {
  return `
window.received = [];
window.addEventListener('message', (event) => window.received.push(event.data));
try {
  const url = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = (event) => window.received.push(event.data);
  window.workerCreated = true;
} catch (error) {
  window.workerCreated = false;
  window.received.push({ constructorError: (error && error.name) || 'error' });
}
`;
}

/** Worker 内的探针：attempts 里每一项都试一次，结果以对象回传。 */
function workerSource(attempts: { name: string; kind: 'fetch' | 'importScripts' | 'eval'; url: string }[]): string {
  return `
(async () => {
  const out = {};
  for (const attempt of ${JSON.stringify(attempts)}) {
    try {
      if (attempt.kind === 'fetch') {
        // no-cors：让「请求发出去了」与「跨来源被 CORS 拒绝」可区分。
        // 被 CSP 拦下时不会走到这里，而是抛 TypeError。
        await fetch(attempt.url, { mode: 'no-cors' });
      } else if (attempt.kind === 'eval') {
        // 沙箱的硬性依赖：uniscope 用 eval/Function 编译用户脚本（3.6/design）。
        // script-src 无 unsafe-eval 时这里抛 EvalError。
        out[attempt.name] = String(eval(attempt.url));
      } else {
        importScripts(attempt.url);
      }
      if (out[attempt.name] === undefined) out[attempt.name] = 'reached';
    } catch (error) {
      out[attempt.name] = (error && error.name) || 'error';
    }
  }
  self.postMessage(out);
})();
`;
}

/** 起一个承载页服务：`/` 是带 CSP 的页面，`/host.js` 是同源外部脚本（受 script-src 'self' 允许）。 */
async function startHarness(csp: string, source: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content=${JSON.stringify(csp)}>
<title>worker csp harness</title>
</head><body>
<script src="/host.js"></script>
</body></html>`;

  const server: Server = createServer((req, res) => {
    if (req.url === '/host.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(hostScript(source));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

type ProbeResult = Record<string, string>;

describe('blob Worker 对文档 CSP 的继承', () => {
  let browser: Browser;
  let recorder: Recorder;

  beforeAll(async () => {
    browser = await launchBrowser();
    recorder = await startRecorder();
  });

  afterAll(async () => {
    await browser?.close();
    await recorder?.close();
  });

  /** 打开承载页，等 worker 回传结果。 */
  async function runProbe(csp: string, attempts: Parameters<typeof workerSource>[0]) {
    const harness = await startHarness(csp, workerSource(attempts));
    const page = await browser.newPage();
    await page.goto(harness.origin);

    expect(
      await page.evaluate(() => (globalThis as unknown as { workerCreated: boolean }).workerCreated),
      '承载页里应当成功建出 Worker（worker-src 允许 blob:）',
    ).toBe(true);

    await page.waitForFunction(
      () => (globalThis as unknown as { received: ProbeResult[] }).received.length > 0,
      undefined,
      { timeout: 10_000 },
    );

    const received = await page.evaluate(
      () => (globalThis as unknown as { received: ProbeResult[] }).received,
    );
    await page.close();
    await harness.close();

    return received[0];
  }

  it('正对照：CSP 允许时，Worker 的 fetch 与 importScripts 都能到达目标', async () => {
    recorder.reset();
    const permissive = [
      "default-src 'none'",
      `script-src 'self' ${recorder.origin}`,
      'worker-src blob:',
      `connect-src ${recorder.origin}`,
    ].join('; ');

    const result = await runProbe(permissive, [
      { name: 'fetch', kind: 'fetch', url: `${recorder.origin}/counted-fetch` },
      { name: 'importScripts', kind: 'importScripts', url: `${recorder.origin}/counted-script.js` },
    ]);

    expect(result, '探针本身必须能成功，否则后面的「被拦」毫无意义').toEqual({
      fetch: 'reached',
      importScripts: 'reached',
    });
    expect(recorder.seen).toContain('/counted-fetch');
    expect(recorder.seen).toContain('/counted-script.js');
  });

  it('应用实际配置的 CSP 会拦住 Worker 对外的 fetch', async () => {
    recorder.reset();

    const result = await runProbe(APP_CSP, [
      { name: 'fetch', kind: 'fetch', url: `${recorder.origin}/blocked-fetch` },
    ]);

    expect(result.fetch, 'CSP 拦截表现为 TypeError').toBe('TypeError');
    expect(recorder.seen, '被拦下的请求不应到达目标').not.toContain('/blocked-fetch');
  });

  it('应用实际配置的 CSP 会拦住 Worker 的 importScripts', async () => {
    recorder.reset();

    const result = await runProbe(APP_CSP, [
      {
        name: 'importScripts',
        kind: 'importScripts',
        url: `${recorder.origin}/blocked-script.js`,
      },
    ]);

    expect(['NetworkError', 'TypeError']).toContain(result.importScripts);
    expect(recorder.seen, '被拦下的脚本不应被取回').not.toContain('/blocked-script.js');
  });

  it('应用 CSP 明确放行 ipc 来源，Worker 内的请求不因 CSP 被拦（该面交由任务 1.4 覆盖）', async () => {
    const harness = await startHarness(
      APP_CSP,
      workerSource([{ name: 'ipc', kind: 'fetch', url: 'http://ipc.localhost/probe' }]),
    );
    const page = await browser.newPage();

    const reached: string[] = [];
    await page.route('http://ipc.localhost/**', (route) => {
      reached.push(route.request().url());
      return route.fulfill({ status: 200, body: 'ok' });
    });

    await page.goto(harness.origin);
    await page.waitForFunction(
      () => (globalThis as unknown as { received: ProbeResult[] }).received.length > 0,
      undefined,
      { timeout: 10_000 },
    );

    const received = await page.evaluate(
      () => (globalThis as unknown as { received: ProbeResult[] }).received,
    );

    // 这条不是「期望被拦」，而是把事实钉住：应用的 connect-src 显式包含 ipc 来源，
    // 因此沙箱一旦被逃逸，CSP 不会阻止它尝试走 Tauri 的 IPC 入口。这正是 1.4 必须在
    // 实机上验证「脚本无法调用后端命令」的原因。
    expect(received[0].ipc).toBe('reached');
    expect(reached.length, 'ipc 来源的请求确实发起了').toBeGreaterThan(0);

    await page.close();
    await harness.close();
  });
});

describe('沙箱对 unsafe-eval 的依赖（9.1）', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** eval 探针需要独立的 harness（runProbe 只发网络探针），单独起页。 */
  async function runEvalProbe(csp: string) {
    const harness = await startHarness(csp, workerSource([{ name: 'eval', kind: 'eval', url: '1+1' }]));
    const page = await browser.newPage();
    await page.goto(harness.origin);

    await page.waitForFunction(
      () => (globalThis as unknown as { received: ProbeResult[] }).received.length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const received = await page.evaluate(
      () => (globalThis as unknown as { received: ProbeResult[] }).received,
    );
    await page.close();
    await harness.close();

    return received[0];
  }

  it('应用 CSP（含 unsafe-eval）下，Worker 内的 eval 可用——沙箱的硬性前提', async () => {
    const result = await runEvalProbe(APP_CSP);
    expect(
      result.eval,
      '脚本沙箱靠 eval/Function 编译用户脚本：这里被拦意味着生产构建里脚本全部失效',
    ).toBe('2');
  });

  it('script-src 无 unsafe-eval 时 Worker 内的 eval 被拦——审计据此钉住该指令', async () => {
    // 与应用 CSP 唯一的差别是去掉 unsafe-eval，证明「eval 可用」确实由它保证
    const withoutEval = APP_CSP.replace(" 'unsafe-eval'", '');
    expect(withoutEval).not.toBe(APP_CSP, '替换应生效');

    const result = await runEvalProbe(withoutEval);
    expect(result.eval, '没有 unsafe-eval，eval 必须被拦').toBe('EvalError');
  });
});
