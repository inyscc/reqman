// 变量候选在真实应用里的行为（change: suggest-variables-while-typing，任务 4.2）。
//
// 为什么必须在真浏览器里验：
// 1. 浮层锚点是**字符到像素**的换算（地址栏按 input 自己的排版量前缀宽度），happy-dom 没有排版；
// 2. 插入后光标要回到插入点之后——这条依赖受控输入在真实引擎里的取值与 `setSelectionRange`
//    时序，单元测试只能验到 `selectionStart` 这个数，验不到「接着敲的字符落在哪」；
// 3. 「候选不改变布局」只能在有真实布局的地方断言。
//
// 应用在没有 Tauri 的环境里起不来，因此注入一个最小假后端：一个集合 + 一个请求 + 三个变量。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__invoked = [];
window.__TAURI_INTERNALS__ = {
  transformCallback: function (callback) {
    var id = Math.floor(Math.random() * 1000000);
    window['_' + id] = callback;
    return id;
  },
  unregisterCallback: function (id) { delete window['_' + id]; },
  convertFileSrc: function (path) { return path; },
  invoke: async function (cmd, args) {
    window.__invoked.push(cmd);
    var auth = { kind: 'inherit', basic: null, bearer: null, api_key: null };
    var workspace = { id: 'w1', name: '候选工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '候选集合', auth: auth,
      pre_request_script: null, test_script: null, sort_order: 0
    };
    var environment = { id: 'e1', workspace_id: 'w1', name: '本地', auth: auth, proxy: null, sort_order: 0 };
    window.__settings = window.__settings || {};

    function variable(name, value, extra) {
      var stored = { state: 'value', value: value };
      return {
        id: 'v-' + name, scope: 'environment', owner_id: 'e1', name: name,
        is_secret: Boolean(extra && extra.secret), enabled: true, sort_order: 0,
        initial: stored, current: stored
      };
    }

    // 当前作用域：baseUrl / host / 一个 secret；集合里再放一个 token（集合层的那份被环境盖过）
    var environmentVariables = [
      variable('host', 'env.test'),
      variable('baseUrl', 'https://env.test'),
      variable('token', '••••••', { secret: true })
    ];
    var collectionVariables = [
      variable('token', 'col-token'),
      variable('collection-only', 'col-value')
    ];

    var request = {
      id: 'r-1', collection_id: 'c1', folder_id: null, name: '候选探针',
      method: 'GET', url: 'https://api.test/users',
      params: [{ key: 'q', value: '', enabled: true }],
      headers: [],
      body: {
        kind: 'raw', raw: '', raw_language: 'json', form: [], urlencoded: [], binary: null
      },
      auth: auth,
      settings: {
        timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
        http_version: 'auto', encoding: null, proxy: null
      },
      pre_request_script: null, test_script: null, sort_order: 0
    };

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: collection,
          children: [{ kind: 'request', id: 'r-1', name: '候选探针', sort_order: 0, children: [], request: request }]
        }];
      case 'environment_list': return [environment];
      case 'environment_active': return environment;
      case 'globals_list': return [];
      case 'variable_list': return args.scope === 'collection' ? collectionVariables : environmentVariables;
      case 'collection_get': return collection;
      case 'folder_get': return null;
      case 'request_get': return request;
      case 'settings_get': return window.__settings[cmd + ':' + args.scope + ':' + args.key] || null;
      case 'settings_set': return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/users', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], masked: false, insecure_warning: false
        };
      case 'cookie_query': return [];
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
    // 端口避开 tauri dev（1420）与其它 browser 用例已占用的 5187–5206
    server: { port: 5202, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5202}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(15_000);
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').getByText('候选探针').click();
  await page.getByLabel('请求地址').waitFor();
  return page;
}

const POPUP = '[data-testid="variable-suggest"]';

/** 在地址栏里清空并键入一段以 `{{` 结尾的文本。 */
async function typeUrl(page: Page, text: string) {
  const input = page.getByLabel('请求地址');
  await input.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

describe('地址栏的候选（真实渲染）', () => {
  it('键入 `{{` 就在光标下方弹出，且不改变布局', async () => {
    const page = await openApp();

    await typeUrl(page, 'https://api.test/{{');
    await page.locator(POPUP).waitFor();

    const geometry = await page.evaluate(() => {
      const input = document.querySelector('[aria-label="请求地址"]') as HTMLElement;
      const popup = document.querySelector('[data-testid="variable-suggest"]') as HTMLElement;
      const band = document.querySelector('.request-top') as HTMLElement;
      return {
        input: input.getBoundingClientRect().toJSON(),
        popup: popup.getBoundingClientRect().toJSON(),
        band: band.getBoundingClientRect().height,
        // 输入框本身的位置也是布局的一部分：弹出前后它不该挪动
        inputTop: input.getBoundingClientRect().top,
        paneTop: (document.querySelector('.pane-body') as HTMLElement).getBoundingClientRect().top,
      };
    });

    // 在输入框下方（同一行放不下时才会翻到上方，这个位置放得下）
    expect(geometry.popup.top).toBeGreaterThanOrEqual(geometry.input.bottom - 1);
    // 锚在光标附近，而不是钉在屏幕左上角
    expect(geometry.popup.left).toBeGreaterThanOrEqual(geometry.input.left - 1);
    expect(geometry.popup.left).toBeLessThan(geometry.input.right);
    // 覆盖层：收起之后请求带的高度、地址栏与正文区的上沿都不变
    await page.keyboard.press('Escape');
    await expect.poll(async () => page.locator(POPUP).count()).toBe(0);

    const after = await page.evaluate(() => {
      const input = document.querySelector('[aria-label="请求地址"]') as HTMLElement;
      return {
        band: (document.querySelector('.request-top') as HTMLElement).getBoundingClientRect().height,
        inputTop: input.getBoundingClientRect().top,
        paneTop: (document.querySelector('.pane-body') as HTMLElement).getBoundingClientRect().top,
      };
    });

    expect(after.band).toBe(geometry.band);
    expect(after.inputTop).toBe(geometry.inputTop);
    expect(after.paneTop).toBe(geometry.paneTop);

    await page.close();
  });

  it('回车插入后，接着键入的字符落在插入点之后', async () => {
    const page = await openApp();
    const input = page.getByLabel('请求地址');

    await typeUrl(page, 'https://api.test/{{ho');
    await page.locator(`${POPUP} [data-name="host"]`).waitFor();

    await page.keyboard.press('Enter');
    await expect.poll(async () => input.inputValue()).toBe('https://api.test/{{host}}');

    // 这就是「光标归位」的真正验法：不用 setSelectionRange 的话，这里会追加到整段末尾
    await page.keyboard.type('/X');
    expect(await input.inputValue()).toBe('https://api.test/{{host}}/X');

    // 插入完成后候选应当收起
    expect(await page.locator(POPUP).count()).toBe(0);

    await page.close();
  });

  it('鼠标点选即插入，输入框保持焦点', async () => {
    const page = await openApp();
    const input = page.getByLabel('请求地址');

    await typeUrl(page, '{{ba');
    const item = page.locator(`${POPUP} [data-name="baseUrl"]`);
    await item.waitFor();

    await item.click();
    await expect.poll(async () => input.inputValue()).toBe('{{baseUrl}}');

    // 焦点没有丢：接着敲的字符仍然进地址栏，并落在插入点之后
    await page.keyboard.type('Y');
    expect(await input.inputValue()).toBe('{{baseUrl}}Y');

    await page.close();
  });

  it('Esc 收起且不改动文本', async () => {
    const page = await openApp();
    const input = page.getByLabel('请求地址');

    await typeUrl(page, 'https://api.test/{{');
    await page.locator(POPUP).waitFor();

    await page.keyboard.press('Escape');
    await expect.poll(async () => page.locator(POPUP).count()).toBe(0);
    expect(await input.inputValue()).toBe('https://api.test/{{');

    await page.close();
  });

  it('点击浮层之外收起', async () => {
    const page = await openApp();

    await typeUrl(page, 'https://api.test/{{');
    await page.locator(POPUP).waitFor();

    await page.mouse.click(60, 700);
    await expect.poll(async () => page.locator(POPUP).count()).toBe(0);

    await page.close();
  });

  it('候选里 secret 只显示掩码', async () => {
    const page = await openApp();

    await typeUrl(page, '{{tok');
    const item = page.locator(`${POPUP} [data-name="token"]`);
    await item.waitFor();

    const text = (await item.innerText()).replace(/\s+/g, ' ');
    expect(text).toContain('••••••');
    expect(text).not.toContain('col-token');

    await page.close();
  });
});

describe('参数表的候选（真实渲染）', () => {
  it('取值列里键入 `{{` 同样弹出，选中写回该行', async () => {
    const page = await openApp();

    // 请求编辑器默认停在 Body 页，先切到 Params
    await page.getByRole('button', { name: 'Params' }).click();
    const value = page.getByLabel('参数值（可用 {{var}}） 0');
    await value.click();
    await page.keyboard.type('{{ho');
    await page.locator(`${POPUP} [data-name="host"]`).waitFor();

    await page.keyboard.press('Enter');
    await expect.poll(async () => value.inputValue()).toBe('{{host}}');

    // 与地址栏同源：参数表写的查询串会回到地址栏（spec: URL 与参数表保持同步）
    expect(await page.getByLabel('请求地址').inputValue()).toContain('q={{host}}');

    await page.close();
  });
});
