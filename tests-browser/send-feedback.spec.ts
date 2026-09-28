// 发送中的响应区反馈（spec: ui-layout「发送中的响应区反馈」）。
//
// 为什么必须真浏览器：遮罩要盖住正文却不盖住工具条、遮罩要真的是半透明、进度线上跑动的
// 那一段要按 prefers-reduced-motion 让位——这三件事都是真实几何与真实样式，happy-dom 量不到。
//
// 浏览器从 `./browser` 取（本机 Chrome → 本机 Edge 的退回链），本仓库严禁安装
// Playwright 自带的 Chromium。假后端与 editor-appearance / response-format-selector 同源，
// 差别只有两点：settings 落 localStorage（便于断言），发送与取消可被测试控制。

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
        // 延迟由用例控制：不设则是下一轮任务（0ms），设了就停在「发送进行中」
        var delay = window.__sendDelay || 0;
        return new Promise(function (resolve, reject) {
          window.__pendingSend = { reject: reject };
          setTimeout(function () {
            var next = window.__responses.shift();
            __storeQueue();
            resolve(next);
          }, delay);
        });
      }
      case 'cancel_send': {
        // 真实后端收到取消后会让在飞的那次发送以 cancelled 结束，这里照同一条因果
        if (window.__pendingSend) {
          window.__pendingSend.reject({ code: 'cancelled', message: '请求已被取消' });
          window.__pendingSend = null;
        }
        return 1;
      }
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
    // 端口避开 1420（tauri dev）与 5192–5201、5204（其它浏览器用例）
    server: { port: 5205, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5205}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** 一次响应载荷；`content_type` 同时写进 headers，与后端一致。 */
function payload(text: string) {
  return {
    id: `resp-${Math.random().toString(36).slice(2, 8)}`,
    status: 200,
    status_text: 'OK',
    elapsed_ms: 7,
    size_bytes: text.length,
    declared_size_bytes: text.length,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: text,
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 5 * 1024 * 1024,
    size_limit_bytes: 50 * 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/1',
    via_proxy: false,
    http_version: 'HTTP/1.1',
    unresolved: [],
  };
}

async function openApp(
  responses: unknown[],
  options: { reducedMotion?: 'reduce' | 'no-preference' } = {},
): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 760 },
    reducedMotion: options.reducedMotion,
  });
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').waitFor();
  await page.evaluate(
    (list) => {
      (globalThis as never as { __responses: unknown[] }).__responses = list as never[];
      localStorage.setItem('__responses', JSON.stringify(list));
    },
    responses,
  );
  return page;
}

/** 打开请求并点一次发送（不等它结束）。 */
async function startSend(page: Page) {
  await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
  await page.getByLabel('请求地址').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 10_000 });
}

/**
 * 让下一次发送停在进行中。
 *
 * 给得比"读到界面所需的时间"宽裕：并行跑整套浏览器用例时机器会被压满，
 * 延迟太短会让新响应在断言之前就到达（本文件曾经因此偶发失败）。
 */
function slowDownSend(page: Page, ms = 3_000) {
  return page.evaluate((delay) => {
    (globalThis as never as { __sendDelay: number }).__sendDelay = delay;
  }, ms);
}

/** 响应正文当前的文本（Monaco 的行拼起来；空白归一化同其它用例）。 */
async function bodyText(page: Page): Promise<string> {
  // Monaco 的行是异步画出来的：不等它就会读到空串
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-testid="response-body"]');
      if (!host) return false;
      if (host.tagName === 'PRE') return (host.textContent ?? '').trim() !== '';
      return host.querySelectorAll('.view-lines .view-line').length > 0;
    },
    undefined,
    { timeout: 10_000 },
  );

  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="response-body"]');
    if (!host) return '';
    const raw =
      host.tagName === 'PRE'
        ? host.textContent ?? ''
        : Array.from(host.querySelectorAll('.view-lines .view-line'))
            .map((line) => line.textContent ?? '')
            .join('\n');
    return raw.replace(/\u00a0/g, ' ');
  });
}

describe('发送中的响应区反馈（真实引擎）', () => {
  it('首次发送：遮罩铺满正文区、工具条可见但不可用', async () => {
    const page = await openApp([payload('{"a":1}')]);
    try {
      await slowDownSend(page);
      await startSend(page);

      const loading = page.getByTestId('response-loading');
      await loading.waitFor({ timeout: 5_000 });

      // 响应头出现「发送中」标识（与遮罩同一个触发条件）
      expect(await page.getByTestId('response-sending').count()).toBe(1);

      // 遮罩铺满正文区：外框与承载它的那一层完全重合
      const boxes = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="response-loading"]') as HTMLElement;
        const area = document.querySelector('.response-body-area') as HTMLElement;
        const a = overlay.getBoundingClientRect();
        const b = area.getBoundingClientRect();
        return {
          width: Math.round(a.width),
          height: Math.round(a.height),
          areaWidth: Math.round(b.width),
          areaHeight: Math.round(b.height),
        };
      });
      expect(boxes.width).toBe(boxes.areaWidth);
      expect(boxes.height).toBe(boxes.areaHeight);

      // 遮罩是**半透明**的浅灰白：旧内容要能透出来（这是它与"不透明实底"的区别）
      const scrim = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="response-loading"]') as HTMLElement;
        return {
          background: getComputedStyle(overlay).backgroundColor,
          children: overlay.childElementCount,
        };
      });
      const alpha = Number((scrim.background.match(/rgba?\([^)]*?,\s*([\d.]+)\)$/) ?? [])[1] ?? '1');
      expect(alpha, `遮罩应半透明，实际 ${scrim.background}`).toBeGreaterThan(0.5);
      expect(alpha, `遮罩应半透明，实际 ${scrim.background}`).toBeLessThan(1);
      // 遮罩里不摆占位行（spec: 不呈现任何看似真实响应内容的数据）
      expect(scrim.children, '遮罩里不该有占位内容').toBe(0);

      // 空态文案让位给遮罩（首次发送时正文区本来什么都没有）
      expect(await page.getByText('尚未发送请求。').count()).toBe(0);

      // 发送结束后反馈消失
      await page.getByTestId('status').waitFor({ timeout: 15_000 });
      await loading.waitFor({ state: 'detached', timeout: 5_000 });
    } finally {
      await page.close();
    }
  });

  it('再次发送：旧响应仍在遮罩之下，不被清空', async () => {
    const page = await openApp([payload('{"a":1}'), payload('{"b":2}')]);
    try {
      await startSend(page);
      await page.getByTestId('status').waitFor({ timeout: 15_000 });
      expect(await bodyText(page)).toContain('"a"');

      // 第二次：慢下来（给足余量），停在发送进行中
      await slowDownSend(page, 4_000);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByTestId('response-loading').waitFor({ timeout: 5_000 });

      // 旧响应还在（遮罩压在它上面，而不是把它清掉）
      expect(await page.getByTestId('response-body').count(), '旧响应不该被清空').toBe(1);
      expect(await bodyText(page)).toContain('"a"');

      // 工具条保持可见但不可用（遮罩只压正文，不藏工具条）
      expect(await page.getByTestId('response-format').isDisabled()).toBe(true);
      expect(await page.getByTestId('response-wrap').isDisabled()).toBe(true);
      expect(await page.locator('.response-content-type').isVisible()).toBe(true);

      // 收尾后换成新响应
      await page.getByTestId('status').waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        () => {
          const host = document.querySelector('[data-testid="response-body"]');
          return host ? (host.textContent ?? '').includes('b') : false;
        },
        undefined,
        { timeout: 10_000 },
      );
    } finally {
      await page.close();
    }
  });

  it('发送中切到 Headers：照常呈现，且不被遮罩', async () => {
    const page = await openApp([payload('{"a":1}'), payload('{"b":2}')]);
    try {
      await startSend(page);
      await page.getByTestId('status').waitFor({ timeout: 15_000 });

      await slowDownSend(page);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByTestId('response-loading').waitFor({ timeout: 5_000 });

      // 头部标签可用：切过去之后正文区的遮罩不再呈现，头部内容照常
      const responsePanel = page.locator('.response-region');
      await responsePanel.getByRole('button', { name: 'Headers', exact: true }).click();

      expect(await page.getByTestId('response-loading').count()).toBe(0);
      expect(await responsePanel.getByText('content-type').count()).toBeGreaterThan(0);

      // 切回 Body 时它还在（发送还没结束）
      await responsePanel.getByRole('button', { name: 'Body', exact: true }).click();
      await page.getByTestId('response-loading').waitFor({ timeout: 5_000 });

      await page.getByTestId('status').waitFor({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  });

  it('取消后遮罩立即消失，且不呈现为失败', async () => {
    const page = await openApp([payload('{"a":1}')]);
    try {
      await slowDownSend(page, 3_000);
      await startSend(page);
      await page.getByTestId('response-loading').waitFor({ timeout: 5_000 });

      await page.getByTestId('cancel-send').click();

      await page
        .getByTestId('response-loading')
        .waitFor({ state: 'detached', timeout: 5_000 });
      expect(await page.getByTestId('response-sending').count()).toBe(0);
      // 取消不是失败：不弹错误（底部状态条回到「就绪」）
      expect(await page.getByTestId('status-bar').textContent()).toBe('就绪');
    } finally {
      await page.close();
    }
  });

  it('减少动效偏好下遮罩与进度线照常呈现，但跑动的那一段不出现', async () => {
    const page = await openApp([payload('{"a":1}')], { reducedMotion: 'reduce' });
    try {
      await slowDownSend(page);
      await startSend(page);
      await page.getByTestId('response-loading').waitFor({ timeout: 5_000 });

      const state = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="response-loading"]') as HTMLElement;
        const style = getComputedStyle(overlay, '::after');
        return {
          animationName: style.animationName,
          scrim: getComputedStyle(overlay).backgroundColor,
        };
      });

      // 零动画下加载态照样说得清：遮罩还在，跑动的那一段让位，响应头的「发送中」标识常驻
      expect(state.scrim, '遮罩应仍在').not.toBe('rgba(0, 0, 0, 0)');
      expect(await page.getByTestId('response-sending').count()).toBe(1);
      expect(state.animationName, '减少动效下不该有跑动的那一段').toBe('none');

      // 发送仍照常收尾（少一道动画不影响状态机）
      await page.getByTestId('status').waitFor({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  });

  it('默认偏好下进度线在跑，且周期不短于 1.2 秒', async () => {
    const page = await openApp([payload('{"a":1}')]);
    try {
      await slowDownSend(page);
      await startSend(page);
      await page.getByTestId('response-loading').waitFor({ timeout: 5_000 });

      const scan = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="response-loading"]') as HTMLElement;
        const style = getComputedStyle(overlay, '::after');
        return {
          animationName: style.animationName,
          duration: style.animationDuration,
          top: style.top,
          height: parseFloat(style.height),
          widthRatio: parseFloat(style.width) / overlay.getBoundingClientRect().width,
        };
      });

      expect(scan.animationName).toBe('response-scan');
      expect(parseFloat(scan.duration), `周期应不短于 1.2s，实际 ${scan.duration}`).toBeGreaterThanOrEqual(
        1.2,
      );

      // 形状：正文区**顶边**上的一条细线，不是铺满整块的扫光
      expect(scan.top, '跑动的那一段应贴在正文区顶边').toBe('0px');
      expect(scan.height, '跑动的那一段应是细线').toBeLessThanOrEqual(3);
      expect(scan.widthRatio, '跑动的那一段不该盖满整行').toBeLessThan(0.6);

      await page.getByTestId('status').waitFor({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  });
});
