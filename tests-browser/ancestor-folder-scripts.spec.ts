// 目录链脚本编排在**真实引擎**里的行为
// （change: run-ancestor-folder-scripts，任务 4.2 / 5.5）。
//
// 为什么必须真浏览器：脚本执行走的是生产路径上的 blob Worker 后端，与 `npm test` 下
// 的 worker_threads 后端是两套实现。这一条验的是「发送时到底编排了几层、以什么顺序」，
// 它由多个模块接力完成（App 取链 → folderChain 上溯 → runScriptPhase 逐段执行），
// 任一环节在真实环境下掉链子，jsdom 那一层都看不出来。
//
// 应用在没有 Tauri 的环境里起不来（`__TAURI_INTERNALS__` 不存在），因此这里在文档
// 起点注入一个最小的假后端：一个集合 + 三层嵌套目录 + 一个位于最内层的请求，每层都
// 配了前置与后置脚本。所有归属变更由假后端**真的记住**，否则「拖拽后按新归属执行」
// 就无从验证。
//
// 浏览器从 `./browser` 取（自带 Chromium → 本机 Chrome → 本机 Edge 的退回链），
// 本仓库严禁安装 Playwright 自带的 Chromium。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__TAURI_INTERNALS__ = {
  transformCallback: function (callback) {
    var id = Math.floor(Math.random() * 1000000);
    window['_' + id] = callback;
    return id;
  },
  unregisterCallback: function (id) { delete window['_' + id]; },
  convertFileSrc: function (path) { return path; },
  invoke: async function (cmd, args) {
    window.__invoked = (window.__invoked || []).concat([cmd]);
    var auth = { kind: 'inherit', basic: null, bearer: null, api_key: null };
    var workspace = { id: 'w1', name: '探针工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '探针集合', auth: auth,
      pre_request_script: "console.log('集合前置');", test_script: "console.log('集合后置');",
      sort_order: 0
    };
    // 设置表要真的记住：脚本门禁（script_gate）与标签集合都存在这里，
    // 假实现若每次都返回 null，「允许执行」之后会反复弹门禁
    window.__settings = window.__settings || {};
    function settingKey(scope, key) { return scope + ':' + key; }
    // 这个集合的脚本视为「此前已授权」（用户在本应用里编辑并保存过脚本就是这条路径）。
    // 门禁本身另有用例覆盖，本文件要验的是编排了几层，不该被确认流程打断。
    window.__settings['script_gate:c1'] = 'allowed';

    function folder(id, parent, name) {
      return {
        id: id, collection_id: 'c1', parent_folder_id: parent, name: name,
        description: null, auth: auth,
        pre_request_script: "console.log('" + name + "前置');",
        test_script: "console.log('" + name + "后置');",
        sort_order: 0
      };
    }
    var folders = {
      f1: folder('f1', null, '第一层'),
      f2: folder('f2', 'f1', '第二层'),
      f3: folder('f3', 'f2', '第三层'),
      'f-target': folder('f-target', null, '目标目录')
    };
    // 请求的**当前**归属：拖拽落库后由 request_move 改写，发送时读到的就是它
    window.__requestFolder = window.__requestFolder || 'f3';

    function request(id, name, url) {
      return {
        id: id, collection_id: 'c1', folder_id: window.__requestFolder, name: name,
        method: 'GET', url: url, params: [], headers: [],
        body: { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null },
        auth: auth,
        settings: {
          timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
          http_version: 'auto', encoding: null, proxy: null
        },
        pre_request_script: "console.log('请求前置');",
        test_script: "console.log('请求后置');",
        sort_order: 0
      };
    }
    var deep = request('r-deep', '深处的请求', 'https://api.test/deep');

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: collection,
          children: [
            {
              kind: 'folder', id: 'f1', name: '第一层', sort_order: 0,
              children: [{
                kind: 'folder', id: 'f2', name: '第二层', sort_order: 0,
                children: [{
                  kind: 'folder', id: 'f3', name: '第三层', sort_order: 0,
                  children: [{
                    kind: 'request', id: 'r-deep', name: '深处的请求', sort_order: 0,
                    children: [], request: deep
                  }]
                }]
              }]
            },
            { kind: 'folder', id: 'f-target', name: '目标目录', sort_order: 1, children: [] }
          ]
        }];
      case 'environment_list': return [];
      case 'environment_active': return null;
      case 'globals_list': return [];
      case 'variable_list': return [];
      // 脚本运行时会用当前请求目标查一次 Cookie（pm.cookies 的当前集合）；
      // 空数组与「一条都没有」同形，返回 null 会让宿主读 length 时炸掉
      case 'cookie_query': return [];
      case 'collection_get': return collection;
      case 'folder_get': return folders[args && args.id] || null;
      case 'request_get': return request('r-deep', '深处的请求', 'https://api.test/deep');
      case 'request_move':
        window.__requestFolder = (args && args.folderId) || null;
        return request('r-deep', '深处的请求', 'https://api.test/deep');
      case 'settings_get': return window.__settings[settingKey(args.scope, args.key)] || null;
      case 'settings_set':
        window.__settings[settingKey(args.scope, args.key)] = args.value;
        return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/deep', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], masked: false, insecure_warning: false
        };
      case 'send_request':
        return {
          id: 'resp-1', status: 200, status_text: 'OK', elapsed_ms: 1,
          size_bytes: 2, declared_size_bytes: 2, truncated: false,
          headers: [['content-type', 'application/json']],
          content_type: 'application/json', body_text: '{}', body_base64: null,
          pretty_available: true, pretty_print_threshold: 1024,
          size_limit_bytes: 50 * 1024 * 1024, insecure_warning: false,
          final_url: 'https://api.test/deep', via_proxy: false, http_version: 'HTTP/1.1',
          request_url: 'https://api.test/deep', unresolved: []
        };
      case 'plugin:event|listen': return 1;
      default: return null;
    }
  }
};
`;

let server: ViteDevServer;
let origin = '';
let browser: Browser;

beforeAll(async () => {
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    // 端口避开 1420（tauri dev）与其它 browser 用例已占用的 5192–5199
    server: { port: 5191, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5191}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // 默认 30s 太长：一步没等到就该在这一步失败，而不是把整条用例拖到超时
  page.setDefaultTimeout(15_000);
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').getByText('深处的请求').waitFor();
  return page;
}

/** 打开最内层的请求标签。 */
async function openDeepRequest(page: Page): Promise<void> {
  await page.getByTestId('workspace-tree').getByText('深处的请求').click();
  await page.getByLabel('请求地址').waitFor();
}

/**
 * 发送，并把可能出现的脚本门禁过掉。
 *
 * 首次执行某个集合的脚本前必须确认（spec: pm-script-runtime「脚本来源的可执行性门禁」）：
 * 假后端已把这个集合记为「已授权」，因此正常路径上不会弹；这里仍兜一手，免得门禁的呈现
 * 时机变化把用例拖成超时（门禁本身另有用例）。
 */
async function sendAndApprove(page: Page): Promise<void> {
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const gate = page.getByTestId('script-gate');
  const appeared = await gate
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);

  if (appeared) {
    await gate.getByRole('button', { name: '允许执行（记住此集合）' }).click();
  }
}

interface ConsoleLine {
  phase: string;
  text: string;
}

/**
 * 切到响应区的「脚本」标签，读回 console 的每条输出（顺序即执行顺序）。
 *
 * 这个标签**只在本次发送产生了脚本输出时才存在**（见 ResponsePanel）：它的出现本身就是
 * 「脚本确实跑了」的信号，因此先等它、再点。
 */
async function readConsole(page: Page): Promise<ConsoleLine[]> {
  const tab = page.getByRole('button', { name: '脚本', exact: true });
  await tab.waitFor();
  await tab.click();
  const list = page.getByTestId('script-console');
  await list.waitFor();

  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="script-console"] li')).map((item) => ({
      phase: item.getAttribute('data-phase') ?? '',
      // 行首的 `[前置 · log]` 是来源标记，去掉它才拿到脚本自己打印的内容
      text: (item.textContent ?? '').replace(/^\[[^\]]*\]\s*/, ''),
    })),
  );
}

const texts = (lines: ConsoleLine[], phase: string): string[] =>
  lines.filter((line) => line.phase === phase).map((line) => line.text);

describe('目录链脚本编排（真实引擎）', () => {
  it('三层嵌套目录：前置与后置各五条日志，顺序为由外到内（5.5）', async () => {
    const page = await openApp();
    try {
      await openDeepRequest(page);
      await sendAndApprove(page);

      const lines = await readConsole(page);

      // 集合 → 第一层 → 第二层 → 第三层 → 请求：五层一层不少，顺序不能换
      expect(texts(lines, 'prerequest')).toEqual([
        '集合前置',
        '第一层前置',
        '第二层前置',
        '第三层前置',
        '请求前置',
      ]);
      // 后置走同一条链、同一次序
      expect(texts(lines, 'test')).toEqual([
        '集合后置',
        '第一层后置',
        '第二层后置',
        '第三层后置',
        '请求后置',
      ]);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('拖进另一个目录后不重开标签直接发送：按新归属的链执行（4.2）', async () => {
    const page = await openApp();
    try {
      await openDeepRequest(page);

      // 把最内层的请求拖进根下的「目标目录」（落在行中间 = 移入），**不重开标签**
      const tree = page.getByTestId('workspace-tree');
      await tree.getByText('深处的请求').dragTo(tree.getByText('目标目录', { exact: true }));
      // 等落库：假后端的「当前归属」真的被 request_move 改写，发送时才读得到新归属
      await page.waitForFunction(
        () => (window as unknown as Record<string, unknown>).__requestFolder === 'f-target',
      );

      await sendAndApprove(page);
      const lines = await readConsole(page);

      // 新归属的链只有「集合 → 目标目录 → 请求」：旧的三层目录一概不再出现
      expect(texts(lines, 'prerequest')).toEqual(['集合前置', '目标目录前置', '请求前置']);
      expect(texts(lines, 'test')).toEqual(['集合后置', '目标目录后置', '请求后置']);
      expect(texts(lines, 'prerequest')).not.toContain('第三层前置');
    } finally {
      await page.close();
    }
  }, 120_000);
});
