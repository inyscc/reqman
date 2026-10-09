// 响应区的代理决定（spec: ui-layout「响应区的代理决定」）。
//
// 为什么必须真浏览器：这条呈现要在**四态之间切换时都留在同一个位置**（成功、失败、
// 直连、降级），而"还看得见吗"取决于真实的布局与鉴识——happy-dom 量不到它有没有被
// 挤出可视区、有没有被后续状态覆盖。
//
// 浏览器从 `./browser` 取（本机 Chrome → 本机 Edge 的退回链），本仓库严禁安装
// Playwright 自带的 Chromium。假后端与 send-feedback 同源，多了一件事：队列里的项可以
// 标记为"这次发送失败"，用来验「失败时仍呈现决定」。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__settings = JSON.parse(localStorage.getItem('__settings') || '{}');
window.__responses = JSON.parse(localStorage.getItem('__responses') || '[]');
function __store(scope, key, value) {
  window.__settings[scope + ':' + key] = value;
  localStorage.setItem('__settings', JSON.stringify(window.__settings));
}
function __storeQueue() {
  localStorage.setItem('__responses', JSON.stringify(window.__responses));
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
      case 'send_request': {
        var delay = window.__sendDelay || 0;
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            var next = window.__responses.shift();
            __storeQueue();
            // 队列里的项可以标记为「这次发送失败」：失败路径是这条呈现的一半
            if (next && next.__reject) { reject(next.error); return; }
            resolve(next);
          }, delay);
        });
      }
      case 'cancel_send': return 0;
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
    // 端口避开 1420（tauri dev）与其它浏览器用例占用的段
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

/** 一次响应载荷；`content_type` 同时写进 headers，与后端一致。 */
function payload(decision: Record<string, unknown>) {
  return {
    id: `resp-${Math.random().toString(36).slice(2, 8)}`,
    status: 200,
    status_text: 'OK',
    elapsed_ms: 7,
    size_bytes: 8,
    declared_size_bytes: 8,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: '{"a":1}',
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 5 * 1024 * 1024,
    size_limit_bytes: 50 * 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/1',
    via_proxy: decision.proxy_url !== null,
    http_version: 'HTTP/1.1',
    proxy_decision: decision,
    unresolved: [],
  };
}

/** 一次失败的发送：错误上带着这次的决定。 */
function failedSend(error: Record<string, unknown>) {
  return { __reject: true, error };
}

const DIRECT = {
  layer: null,
  mode: null,
  proxy_url: null,
  reason: 'unconfigured',
  pac_url: null,
};

async function openApp(queue: unknown[]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').waitFor();
  await page.evaluate(
    (list) => {
      (globalThis as never as { __responses: unknown[] }).__responses = list as never[];
      localStorage.setItem('__responses', JSON.stringify(list));
    },
    queue,
  );
  return page;
}

/** 打开请求并点一次发送，等到它收场（成功或失败）。 */
async function send(page: Page) {
  await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
  await page.getByLabel('请求地址').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="response-loading"]') === null,
    undefined,
    { timeout: 15_000 },
  );
}

function decisionText(page: Page) {
  return page.getByTestId('proxy-decision').textContent({ timeout: 10_000 });
}

describe('响应区的代理决定（真实引擎）', () => {
  it('尚未发送时没有决定可显示', async () => {
    const page = await openApp([payload(DIRECT)]);
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
      await page.getByLabel('请求地址').waitFor({ timeout: 10_000 });

      expect(await page.getByTestId('proxy-decision').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('直连被显式写出来，而不是什么都不显示', async () => {
    const page = await openApp([payload(DIRECT)]);
    try {
      await send(page);
      await page.getByTestId('status').waitFor({ timeout: 10_000 });

      expect(await decisionText(page)).toBe('直连');
    } finally {
      await page.close();
    }
  });

  it('经代理时给出地址，且不出现凭据', async () => {
    // 载荷里刻意多塞凭据字段：界面只该用地址（spec:「决定中不出现凭据」）
    const page = await openApp([
      payload({
        layer: 'request',
        mode: 'manual',
        proxy_url: 'http://10.0.0.1:8080',
        reason: 'manual',
        pac_url: null,
        username: 'proxy-secret-user',
        password: 'proxy-secret-pass',
      }),
    ]);
    try {
      await send(page);
      await page.getByTestId('status').waitFor({ timeout: 10_000 });

      const text = await decisionText(page);
      expect(text).toBe('经代理 http://10.0.0.1:8080');
      expect(text).not.toContain('proxy-secret-user');
      expect(text).not.toContain('proxy-secret-pass');
    } finally {
      await page.close();
    }
  });

  it('命中白名单而直连时写明原因', async () => {
    const page = await openApp([
      payload({
        layer: 'global',
        mode: 'manual',
        proxy_url: null,
        reason: 'whitelisted',
        pac_url: null,
      }),
    ]);
    try {
      await send(page);
      await page.getByTestId('status').waitFor({ timeout: 10_000 });

      expect(await decisionText(page)).toBe('直连 · 命中不走代理的白名单');
    } finally {
      await page.close();
    }
  });

  it('PAC 降级与普通直连呈现得不一样', async () => {
    const page = await openApp([
      payload({
        layer: 'system',
        mode: 'system',
        proxy_url: null,
        reason: 'pac_unavailable',
        pac_url: 'http://internal.example/proxy.pac',
      }),
    ]);
    try {
      await send(page);
      await page.getByTestId('status').waitFor({ timeout: 10_000 });

      const text = await decisionText(page);
      expect(text).toContain('直连');
      expect(text).toContain('PAC 未能取得，已按直连降级');
      expect(text).toContain('http://internal.example/proxy.pac');
    } finally {
      await page.close();
    }
  });

  it('失败时决定仍在响应区', async () => {
    const page = await openApp([
      failedSend({
        code: 'connection_timed_out',
        message: '连接建立超时 (os error 10060)',
        proxy_decision: {
          layer: 'system',
          mode: 'system',
          proxy_url: null,
          reason: 'unconfigured',
          pac_url: null,
        },
      }),
    ]);
    try {
      await send(page);

      // 错误照旧在错误条上
      await page.getByTestId('app-error').waitFor({ timeout: 10_000 });
      expect(await page.getByTestId('app-error').textContent()).toContain('10060');

      // 响应区没有响应元数据，但决定仍要在——失败恰恰是最需要看它的时候
      expect(await decisionText(page)).toBe('直连');
      expect(await page.getByTestId('response-meta').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
