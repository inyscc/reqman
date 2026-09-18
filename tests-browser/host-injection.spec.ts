// Tauri 的「文档起点注入」在浏览器用例里的镜像（任务 9.9 / design D17）。
//
// 为什么必须有这一层：`npm test`（Node 后端）、`npm run test:browser`（裸 Chromium）、
// `npm run test:upstream` 三者全绿，而真机上脚本功能**完全不可用**——因为真客户端除了
// 页面本身，还会在主文档**文档起点**注入一批东西（CSP、原型冻结…），测试环境一份都没有。
// 9.1 已经把 CSP 拉进用例（`worker-csp.spec.ts` 直接读 `tauri.conf.json`），这里补上
// `freezePrototype`：它曾被置为 `true`，而 Tauri 把它实现为 `Object.freeze(Object.prototype)`，
// 于是沙箱宿主侧的 lodash 引导阶段（`source[methodName] = func` 那一轮拷到 `toString`）
// 在模块求值期就抛错，整个沙箱 chunk 加载失败。
//
// 因此本文件**不写死期望值**，而是从 `tauri.conf.json` 读配置、按真机的方式注入：
//   - 配置为 `false`：不注入，沙箱必须能加载并执行脚本；
//   - 配置为 `true`：按真机注入冻结，沙箱加载失败 ⇒ 用例变红。
// 这正是「有人把它改回去」的自动化防线（D17：安全审计不再按值断言这个开关，改由这里钉住）。
//
// CSP 不在这里重复镜像：`worker-csp.spec.ts` 已经承担（它用 meta 注入；对「是否从文档起点
// 生效」而言，meta 与 Tauri 的响应头注入等价）。
//
// 实测记录（Windows + 本机 Chrome 150，随 `npm run test:browser` 一起打印）：
//   - 文档起点注入**进入主文档 realm**：`[注入记录·强制冻结] 主文档冻结=true`；
//   - 但它**不进入 blob Worker 的 realm**：同一行里 `blob Worker 冻结=false`。
// 因此失败面落在**宿主侧**——与 D17 的复现一致（lodash 引导期的拷贝在宿主侧求值时就抛错），
// 沙箱内部那份 bootcode 不受这类注入影响。WebView2 与 Chrome 同属 Chromium 家族、注入走的是
// 同一族 API，预期相同；真机确认属 10.4。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

/** 应用真实配置里的文档起点注入项——直接读配置，不在用例里另写一份期望值。 */
const FREEZE_PROTOTYPE: boolean = (
  JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { security: { freezePrototype: boolean } } }
).app.security.freezePrototype;

/** 与 dev server 同源的空白宿主文档：本用例测的是宿主侧装载路径，不需要应用本身。 */
const HOST_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>host injection harness</title></head><body></body></html>';

const HOST_PATH = '/__host-injection.html';

let server: ViteDevServer;
let origin = '';

beforeAll(async () => {
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    // 端口刻意避开 1420（`npm run tauri dev`）与 5199（script-runtime.spec.ts）
    server: { port: 5197, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5197}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

interface SandboxOutcome {
  error?: string | null;
  thrown?: string;
  console?: string[];
}

/**
 * 打开一个同源的空白宿主页，并按真机方式施加文档起点注入。
 *
 * `page.addInitScript` 对应 Tauri 在 WebView2 上用的 `AddScriptToExecuteOnDocumentCreated`：
 * 都在文档创建后、页面脚本之前执行（`freeze` 只决定是否施加）。
 */
async function openHostPage(browser: Browser, options: { freeze?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage();

  if (options.freeze ?? FREEZE_PROTOTYPE) {
    await page.addInitScript(() => {
      Object.freeze(Object.prototype);
    });
  }

  await page.route(/\/__host-injection\.html$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: HOST_DOCUMENT }),
  );
  await page.goto(`${origin}${HOST_PATH}`, { waitUntil: 'domcontentloaded' });

  return page;
}

/** 观测 blob Worker 的 realm 是否也被冻结（与沙箱用的是同一种 Worker 构造方式）。 */
async function workerRealmFrozen(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const url = URL.createObjectURL(
          new Blob(['postMessage(Object.isFrozen(Object.prototype))'], { type: 'text/javascript' }),
        );
        const worker = new Worker(url);
        worker.onmessage = (event) => resolve(Boolean(event.data));
        worker.onerror = () => resolve(false);
      }),
  );
}

/** 在页面里经 `runScriptPhase` 跑一段脚本——生产路径上宿主侧装载沙箱的地方。 */
async function runScriptInPage(page: Page, script: string): Promise<SandboxOutcome> {
  try {
    return await page.evaluate(async (code: string) => {
      // 用 new Function 包一层：字面量 import() 会被 vitest 改写成 SSR 辅助函数，
      // 而这段代码是在浏览器里求值的
      const dynamicImport = new Function('p', 'return import(p)') as (
        p: string,
      ) => Promise<typeof import('../src/lib/scriptRuntime')>;
      const mod = await dynamicImport('/src/lib/scriptRuntime.ts');

      const commands = {
        settingsGet: async () => null,
        settingsSet: async () => undefined,
        globalsList: async () => [],
        variableList: async () => [],
        globalsSet: async () => ({}),
        variableSet: async () => ({}),
        secretReveal: async () => ({}),
        cookieQuery: async () => [],
        sendRequest: async () => null,
      };

      try {
        const result = await mod.runScriptPhase(
          commands,
          { workspaceId: 'w1', collectionId: 'c1', environmentId: null },
          'prerequest',
          [code],
        );

        return {
          error: result.error,
          console: result.console.map((entry) => entry.args.join(' ')),
        };
      } catch (error) {
        return { thrown: String(error && (error as Error).message) };
      }
    }, script);
  } catch (error) {
    // 页面本身起不来（例如注入把加载器拖死的极端形态）也要能报出原因，而不是让用例以
    // 「evaluate 抛错」的形式失败——正对照里这就是预期结果的一种
    return { thrown: String(error && (error as Error).message) };
  }
}

describe('按 tauri.conf.json 镜像 Tauri 的文档起点注入', () => {
  it('注入与配置一致：主文档的冻结状态等于配置取值，并记录注入是否进入 Worker realm', async () => {
    const browser = await launchBrowser();
    try {
      const page = await openHostPage(browser);

      const frozen = await page.evaluate(() => Object.isFrozen(Object.prototype));
      expect(
        frozen,
        `配置 freezePrototype=${FREEZE_PROTOTYPE}，页面主文档的 Object.prototype 冻结状态应一致`,
      ).toBe(FREEZE_PROTOTYPE);

      // 顺带记录：这类注入是否也会进入 blob Worker 的 realm。这里**只记录、不断言**——
      // 它是浏览器的注入范围，不是本应用的契约；但失败面落在宿主侧还是沙箱内取决于它。
      const workerFrozen = await workerRealmFrozen(page);

      console.log(
        `[注入记录] freezePrototype=${FREEZE_PROTOTYPE}，主文档冻结=${frozen}，blob Worker 冻结=${workerFrozen}`,
      );
      expect(typeof workerFrozen, 'Worker 侧的观测应当拿到结果').toBe('boolean');

      await page.close();
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('按配置注入后，沙箱宿主侧仍能加载并执行一段脚本', async () => {
    const browser = await launchBrowser();
    try {
      const page = await openHostPage(browser);
      const outcome = await runScriptInPage(page, 'console.log("host-injection-ok")');

      expect(
        outcome.thrown,
        '沙箱宿主侧必须能在该注入下完成求值（D17：冻结原型会让它抛错）',
      ).toBeUndefined();
      expect(outcome.error).toBeNull();
      expect(outcome.console?.join(' ')).toContain('host-injection-ok');

      await page.close();
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('正对照：强行注入冻结时，宿主侧装载必须失败——把 D17 的因果钉在用例里', async () => {
    const browser = await launchBrowser();
    try {
      // 无论配置当前是什么，都强制施加冻结：这条断言的是「机制」，不是「当前取值」。
      // 若将来上游/Vite 让这段代码不再受冻结影响，这条会红——那正是需要重新评估
      // 「能不能把 freezePrototype 打开」的时候。
      const page = await openHostPage(browser, { freeze: true });

      // 注入确实生效，否则这条正对照什么也没证明
      expect(await page.evaluate(() => Object.isFrozen(Object.prototype))).toBe(true);

      // 记录注入是否也进了 blob Worker：它决定失败面落在宿主侧还是沙箱内
      const workerFrozen = await workerRealmFrozen(page);
      console.log(`[注入记录·强制冻结] 主文档冻结=true，blob Worker 冻结=${workerFrozen}`);
      expect(typeof workerFrozen).toBe('boolean');

      const outcome = await runScriptInPage(page, 'console.log("should-not-run")');

      expect(
        outcome.thrown ?? '',
        '冻结 Object.prototype 后，lodash 引导期的 toString 拷贝必须被拒',
      ).toMatch(/toString/);
      expect(outcome.thrown ?? '').toMatch(/read only|readonly/);
      expect(outcome.console ?? []).not.toContain('should-not-run');

      await page.close();
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('启动模块图不含沙箱代码（9.2 审计的浏览器侧对照）', async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const requested: string[] = [];
      page.on('request', (request) => requested.push(request.url()));
      // 应用在没有 Tauri 的环境里起不来（`__TAURI_INTERNALS__` 不存在），这里不关心
      page.on('pageerror', () => undefined);

      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      expect(requested.length, '页面确实发出了请求').toBeGreaterThan(0);
      expect(
        requested.filter((url) => url.includes('postman-sandbox')),
        '启动阶段不应请求沙箱 chunk（它只能在首次执行脚本时按需加载）',
      ).toEqual([]);

      await page.close();
    } finally {
      await browser.close();
    }
  }, 60_000);
});
