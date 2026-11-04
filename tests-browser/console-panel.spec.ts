// Console 抽屉的布局与持久化（spec: ui-layout「底部 Console 抽屉占位」）。
//
// 为什么必须真浏览器：抽屉占的是 .app 的第二行，主区是否真的收缩、拖拽是否真的改高度、
// 收起后有没有留下空白带，全是真实几何；happy-dom 里 `.main` 的 offsetHeight 恒为 0。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__settings = JSON.parse(localStorage.getItem('__settings') || '{}');
function __store(scope, key, value) {
  window.__settings[scope + ':' + key] = value;
  localStorage.setItem('__settings', JSON.stringify(window.__settings));
}
window.__TAURI_INTERNALS__ = {
  transformCallback: function (callback) {
    var id = Math.floor(Math.random() * 1000000);
    window['_' + id] = callback;
    return id;
  },
  unregisterCallback: function (id) { delete window['_' + id]; },
  convertFileSrc: function (path) { return path; },
  invoke: async function (cmd, args) {
    var auth = { kind: 'inherit', basic: null, bearer: null, api_key: null };
    var workspace = { id: 'w1', name: '探针工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '探针集合', auth: auth,
      pre_request_script: null, test_script: null, sort_order: 0
    };
    var request = {
      id: 'r1', collection_id: 'c1', folder_id: null, name: '请求 1',
      method: 'GET', url: 'https://api.test/1',
      params: [], headers: [],
      body: { kind: 'raw', raw: '{"a":1}', raw_language: 'json', form: [], urlencoded: [], binary: null },
      auth: auth,
      settings: {
        timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
        http_version: 'auto', encoding: null, proxy: null
      },
      pre_request_script: null, test_script: null, sort_order: 0
    };
    var node = { kind: 'request', id: 'r1', name: '请求 1', sort_order: 0, children: [], request: request };

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree': return [{ collection: collection, children: [node] }];
      case 'environment_list': return [];
      case 'environment_active': return null;
      case 'globals_list': return [];
      case 'variable_list': return [];
      case 'collection_get': return collection;
      case 'folder_get': return null;
      case 'request_get': return request;
      case 'settings_get':
        if (args.scope === 'script_gate') return 'allowed';
        return window.__settings[args.scope + ':' + args.key] || null;
      case 'settings_set':
        __store(args.scope, args.key, args.value);
        return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/1', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], used: [], masked: false, insecure_warning: false
        };
      case 'send_request':
        return {
          id: 'resp-1', status: 200, status_text: 'OK', elapsed_ms: 7, size_bytes: 11,
          declared_size_bytes: 11, truncated: false,
          headers: [['content-type', 'application/json']], content_type: 'application/json',
          body_text: '{"ok":true}', body_base64: null,
          pretty_available: true, pretty_print_threshold: 5242880, size_limit_bytes: 52428800,
          insecure_warning: false, final_url: 'https://api.test/1',
          request_url: 'https://api.test/1',
          request_headers: [['accept', 'application/json']],
          via_proxy: false, http_version: 'HTTP/1.1', unresolved: []
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
    // 端口避开其它浏览器用例的 5192–5205
    server: { port: 5206, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5206}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').waitFor();
  return page;
}

/** 主区的高度：抽屉展开时它必须变小，而不是被盖住。 */
async function mainHeight(page: Page): Promise<number> {
  const box = await page.locator('main.main').boundingBox();
  return box?.height ?? 0;
}

async function drawerHeight(page: Page): Promise<number> {
  const box = await page.getByTestId('console-drawer').boundingBox();
  return box?.height ?? 0;
}

describe('Console 抽屉的占位', () => {
  it('打开后主区收缩，请求编辑器仍可输入', async () => {
    const page = await openApp();
    try {
      // 先打开请求：主区高度要拿「有编辑器」的那一版来比
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
      await page.getByLabel('请求地址').waitFor({ timeout: 10_000 });

      const before = await mainHeight(page);

      await page.getByTestId('console-toggle-closed').click();
      await page.getByTestId('console-panel').waitFor();

      const after = await mainHeight(page);
      expect(after).toBeLessThan(before - 100);
      expect(await drawerHeight(page)).toBeGreaterThan(100);

      // 非模态：编辑器没有被抽屉盖住，点得进去、打得进字
      const url = page.getByLabel('请求地址');
      await url.click();
      await page.keyboard.type('x');
      await expect
        .poll(async () => url.inputValue(), { timeout: 5_000 })
        .toContain('1x');
    } finally {
      await page.close();
    }
  }, 60_000);

  it('收起后不留空白带：主区回到原来的高度', async () => {
    const page = await openApp();
    try {
      const before = await mainHeight(page);

      await page.getByTestId('console-toggle-closed').click();
      await page.getByTestId('console-panel').waitFor();
      await page.getByTestId('console-close').click();
      await page.getByTestId('console-panel').waitFor({ state: 'detached' });

      expect(Math.abs((await mainHeight(page)) - before)).toBeLessThan(1);
      expect(await page.getByTestId('console-drawer').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});

describe('Console 抽屉的高度', () => {
  it('拖动上沿改高度，松手后按工作区落库', async () => {
    const page = await openApp();
    try {
      await page.getByTestId('console-toggle-closed').click();
      await page.getByTestId('console-handle').waitFor();

      const before = await drawerHeight(page);
      const handle = await page.getByTestId('console-handle').boundingBox();
      if (!handle) throw new Error('拖拽区不在');

      // 往上拖 120px：抽屉变高
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y - 120, { steps: 6 });
      await page.mouse.up();

      const after = await drawerHeight(page);
      expect(after).toBeGreaterThan(before + 80);

      const saved = await page.evaluate(() => {
        const raw = localStorage.getItem('__settings');
        return raw ? (JSON.parse(raw) as Record<string, string>)['ui_console:w1'] : null;
      });

      expect(saved).toBeTruthy();
      const ratio = Number.parseFloat(String(saved));
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThanOrEqual(0.6);
    } finally {
      await page.close();
    }
  });

  it('重新加载后高度取回，抽屉默认仍是收起的', async () => {
    const page = await openApp();
    try {
      await page.getByTestId('console-toggle-closed').click();
      await page.getByTestId('console-handle').waitFor();

      const handle = await page.getByTestId('console-handle').boundingBox();
      if (!handle) throw new Error('拖拽区不在');
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y - 140, { steps: 6 });
      await page.mouse.up();

      const dragged = await drawerHeight(page);

      await page.reload({ waitUntil: 'load' });
      await page.getByTestId('workspace-tree').waitFor();

      // 开合不持久化：它是排查工具，不该每次启动都占掉一块屏幕
      expect(await page.getByTestId('console-drawer').count()).toBe(0);

      await page.getByTestId('console-toggle-closed').click();
      await page.getByTestId('console-panel').waitFor();

      // 高度按工作区记住：差几像素是视口与布局取整，不该严格相等
      expect(Math.abs((await drawerHeight(page)) - dragged)).toBeLessThan(6);
    } finally {
      await page.close();
    }
  });
});

describe('Console 在浅色底上的可读性', () => {
  it('URL 与正文用等宽字体，正文区是浅底深字', async () => {
    const page = await openApp();
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
      await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 10_000 });

      await page.getByTestId('console-toggle-closed').click();
      const url = page.locator('.console-url').first();
      await url.waitFor({ timeout: 10_000 });

      const urlFont = await url.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(urlFont.toLowerCase()).toMatch(/mono|consolas/);

      // 展开一次，量正文区
      await url.click();
      const body = page.getByTestId('console-body').first();
      await body.waitFor({ timeout: 10_000 });

      const colors = await body.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, background: style.backgroundColor };
      });

      const [r, g, b] = colors.background.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
      // 浅底：三个通道都亮；深字：文字比底色明显更暗
      expect(Math.min(r, g, b)).toBeGreaterThan(200);
      const [tr, tg, tb] = colors.color.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
      expect((r + g + b) / 3 - (tr + tg + tb) / 3).toBeGreaterThan(60);
    } finally {
      await page.close();
    }
  });
});

describe('Console 条目的复制', () => {
  it('行文字可选中，复制入口悬停显形并把这一行写进剪贴板', async () => {
    // 读回剪贴板要 `clipboard-read` 权限，所以这条用例自建 context
    const context = await browser.newContext({
      viewport: { width: 1200, height: 760 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();

    try {
      await page.addInitScript(FAKE_TAURI);
      await page.goto(origin, { waitUntil: 'load' });
      await page.getByTestId('workspace-tree').waitFor();

      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
      await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 10_000 });

      await page.getByTestId('console-toggle-closed').click();
      const entry = page.getByTestId('console-entry').first();
      await entry.waitFor({ timeout: 10_000 });

      // 行是 role=button 的容器而不是 <button>：UA 的禁选规则不该再套在文字上
      const userSelect = await entry
        .locator('.console-url')
        .evaluate((el) => getComputedStyle(el).userSelect);
      expect(userSelect).toBe('text');

      // 入口默认不显形（不抢宽度），悬停才出现
      const copy = entry.getByTestId('console-copy');
      expect(await copy.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
      await entry.hover();
      await expect.poll(() => copy.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

      await copy.click();
      expect(copy).toBeTruthy();

      const text = await page.evaluate(() => navigator.clipboard.readText());
      expect(text).toBe('GET https://api.test/1 — 200 OK 7 ms');

      // 复制在行内，点它不该顺带把条目展开
      expect(await page.getByTestId('console-body').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);
});
