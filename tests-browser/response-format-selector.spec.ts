// 响应呈现格式在真实引擎里的表现（change: response-format-selector，任务 5.1）。
//
// 为什么要真浏览器：这条链路的三处结论都只在真引擎里成立——响应正文由 Monaco 承载
// （可见文本在 `.view-lines` 里，不在宿主节点上）、格式下拉是自绘浮层、沙箱预览的
// 挂载与卸载是真实的 iframe 生命周期。
//
// 浏览器从 `./browser` 取（自带 Chromium → 本机 Chrome → 本机 Edge 的退回链），
// 本仓库严禁安装 Playwright 自带的 Chromium。假后端与其它浏览器用例同源：
// 没有 Tauri 时应用起不来，因此在文档起点注入最小的 `__TAURI_INTERNALS__`；
// 这里的 invoke 额外记住 settings 并按队列返回响应，以验证「配置落库」与
// 「格式解析」。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__settings = {};
window.__responses = [];
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
      body: { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null },
      auth: auth,
      settings: {
        timeout_ms: null, follow_redirects: true, verify_tls: true,
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
        // 门禁默认放行：与单元测试的假后端同一约定，否则发送会停在确认对话框上
        if (args.scope === 'script_gate') return 'allowed';
        return window.__settings[args.scope + ':' + args.key] || null;
      case 'settings_set':
        window.__settings[args.scope + ':' + args.key] = args.value;
        return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/1', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], used: [], masked: false, insecure_warning: false
        };
      case 'send_request': return window.__responses.shift();
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
    // 端口避开 1420（tauri dev）与 5194–5199（其它浏览器用例）
    server: { port: 5193, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5193}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** 一次响应载荷；`content_type` 同时写进 headers，与后端一致。 */
function payload(overrides: { content_type: string; body_text: string }) {
  return {
    id: `resp-${Math.random().toString(36).slice(2, 8)}`,
    status: 200,
    status_text: 'OK',
    elapsed_ms: 7,
    size_bytes: overrides.body_text.length,
    declared_size_bytes: overrides.body_text.length,
    truncated: false,
    headers: [['content-type', overrides.content_type]],
    content_type: overrides.content_type,
    body_text: overrides.body_text,
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 5 * 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/1',
    via_proxy: false,
    http_version: 'HTTP/1.1',
    unresolved: [],
  };
}

async function openApp(responses: unknown[]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').waitFor();
  await page.evaluate(
    (list) => {
      (globalThis as never as { __responses: unknown[] }).__responses = list as never[];
    },
    responses,
  );
  return page;
}

/** 打开请求并发送一次。 */
async function send(page: Page) {
  await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
  await page.getByLabel('请求地址').waitFor();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByTestId('status').waitFor();
}

/**
 * 等待响应正文变成期望文本。
 *
 * 两处真引擎的坑：正文由 Monaco 承载（文本在 `.view-lines` 的行里，且内容更新是
 * 异步的）；Monaco 把空白渲染成 `\u00a0`，因此比对前统一归一化。
 */
async function waitBody(page: Page, expected: string, exact = true) {
  await page.waitForFunction(
    (options: { expected: string; exact: boolean }) => {
      const host = document.querySelector('[data-testid="response-body"]');
      if (!host) return false;
      const raw =
        host.tagName === 'PRE'
          ? host.textContent ?? ''
          : Array.from(host.querySelectorAll('.view-lines .view-line'))
              .map((line) => line.textContent ?? '')
              .join('\n');
      const text = raw.replace(/\u00a0/g, ' ').trim();
      return options.exact ? text === options.expected : text.includes(options.expected);
    },
    { expected, exact },
    { timeout: 5_000 },
  );

  return readBody(page);
}

/** 读当前响应正文（Monaco 取行文本，pre 取文本节点）。 */
async function readBody(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="response-body"]');
    if (!host) return '';
    const raw =
      host.tagName === 'PRE'
        ? host.textContent ?? ''
        : Array.from(host.querySelectorAll('.view-lines .view-line'))
            .map((line) => line.textContent ?? '')
            .join('\n');
    return raw.replace(/\u00a0/g, ' ').trim();
  });
}

describe('响应呈现格式（真实引擎）', () => {
  it('格式下拉取代双 tab，并标出检测到的格式', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await send(page);

      // 旧的双 tab 不再存在
      expect(await page.getByRole('button', { name: '原始', exact: true }).count()).toBe(0);
      expect(await page.getByRole('button', { name: '格式化', exact: true }).count()).toBe(0);

      const trigger = page.getByTestId('response-format');
      expect(await trigger.getAttribute('data-value')).toBe('auto');

      await trigger.click();
      expect(await page.getByTestId('response-format-badge-json').innerText()).toBe('检测');
    } finally {
      await page.close();
    }
  });

  it('强制解释失败时静默回退原样，检测标记不移动', async () => {
    const page = await openApp([payload({ content_type: 'text/plain', body_text: 'not json' })]);
    try {
      await send(page);

      await page.getByTestId('response-format').click();
      await page.getByRole('option', { name: /^JSON/ }).click();

      expect(await waitBody(page, 'not json')).toBe('not json');
      // 静默回退：不产生任何错误提示（Monaco 自身会挂空的 role=alert 节点，因此
      // 这里按应用的通知元素断言，而不是按 role 断言）
      expect(await page.locator('[data-testid="app-error"]').count()).toBe(0);
      expect(await page.locator('.response-region .notice.danger').count()).toBe(0);

      await page.getByTestId('response-format').click();
      expect(await page.getByTestId('response-format-badge-raw').innerText()).toBe('检测');
      expect(await page.getByTestId('response-format-badge-json').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('Hex 视图把不可见字符摆出来', async () => {
    const page = await openApp([payload({ content_type: 'text/plain', body_text: 'a\u0000b' })]);
    try {
      await send(page);

      await page.getByTestId('response-format').click();
      await page.getByRole('option', { name: /^Hex/ }).click();

      const text = await waitBody(page, '61 00 62', false);
      expect(text.startsWith('00000000  61 00 62')).toBe(true);
      expect(text.endsWith('a.b')).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('预览是开关：关掉之后 HTML 以源码呈现', async () => {
    const page = await openApp([payload({ content_type: 'text/html', body_text: '<p>hi</p>' })]);
    try {
      await send(page);

      expect(await page.getByTestId('sandboxed-preview').count()).toBe(1);

      await page.getByTestId('preview-toggle').click();
      expect(await page.getByTestId('sandboxed-preview').count()).toBe(0);
      expect(await waitBody(page, '<p>hi</p>')).toBe('<p>hi</p>');
    } finally {
      await page.close();
    }
  });

  it('设置列表是行式布局：控件右缘对齐、行间有分隔线、长文本项整宽', async () => {
    const page = await openApp([]);
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByTestId('settings-panel').waitFor();

      const modal = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const panel = document.querySelector('[data-testid="settings-panel"]') as HTMLElement;
        const sections = Array.from(panel.querySelectorAll('.settings-section')).map((section) =>
          Array.from(section.querySelectorAll('.settings-row')).map((node) => {
            const row = node as HTMLElement;
            const control = row.querySelector('input, textarea, .dropdown, .settings-control');
            const name = row.querySelector('.settings-name');
            const rect = row.getBoundingClientRect();
            const controlRect = control?.getBoundingClientRect();
            return {
              stacked: row.classList.contains('stacked'),
              border: getComputedStyle(row).borderBottomWidth,
              rowWidth: round(rect.width),
              controlRight: controlRect ? round(controlRect.right) : null,
              controlTop: controlRect ? round(controlRect.top) : null,
              nameTop: name ? round(name.getBoundingClientRect().top) : null,
              controlWidth: controlRect ? round(controlRect.width) : null,
            };
          }),
        );
        return { sections };
      });

      const rows = modal.sections.flat();
      const inline = rows.filter((row) => !row.stacked && row.controlRight !== null);
      expect(inline.length).toBeGreaterThan(2);
      const rights = new Set(inline.map((row) => row.controlRight));
      expect(rights.size, `各行控件的右缘没有对齐：${JSON.stringify(inline)}`).toBe(1);

      // 行间有分隔线；每节的末行不画（它下面是下一节的标题）
      modal.sections.forEach((section) => {
        section.slice(0, -1).forEach((row) => expect(row.border).toBe('1px'));
        expect(section[section.length - 1].border).toBe('0px');
      });

      // 长文本项（主机名单）整宽，名称在上
      const stacked = rows.find((row) => row.stacked)!;
      expect(stacked.controlWidth).toBeGreaterThan(stacked.rowWidth - 2);
      expect(stacked.controlTop).toBeGreaterThan(stacked.nameTop!);
    } finally {
      await page.close();
    }
  });

  it('模态里的下拉不被滚动容器裁切：菜单挂在 body 上且完整可见、末项可点', async () => {
    const page = await openApp([]);
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByTestId('settings-panel').waitFor();

      // 把设置正文滚到底：下拉此时贴着滚动容器的下缘，菜单一旦留在容器里就会被切
      await page.evaluate(() => {
        const body = document.querySelector('.modal-body') as HTMLElement;
        body.scrollTop = body.scrollHeight;
      });

      await page.getByTestId('format-detection').click();
      await page.getByRole('listbox', { name: '响应格式检测' }).waitFor();

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const menu = document.querySelector('.dropdown-menu') as HTMLElement;
        const rect = menu.getBoundingClientRect();
        const options = Array.from(menu.querySelectorAll('.dropdown-option'));
        const last = options[options.length - 1].getBoundingClientRect();
        return {
          insideModal: Boolean(menu.closest('.modal')),
          top: round(rect.top),
          bottom: round(rect.bottom),
          height: round(rect.height),
          lastBottom: round(last.bottom),
          viewportHeight: window.innerHeight,
        };
      });

      expect(geometry.insideModal, '菜单仍在模态里，会被模态正文的滚动裁掉').toBe(false);
      expect(geometry.height).toBeGreaterThan(0);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);

      // 末项真的可点：被裁切时这一步点不到
      await page.getByRole('option', { name: 'JSON' }).click();
      expect(await page.getByTestId('format-detection').getAttribute('data-value')).toBe('json');
    } finally {
      await page.close();
    }
  });

  it('请求 Settings 用同一套行式列表：布尔项是开关、选项走通用下拉', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await send(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('.request-editor .settings-section').waitFor();

      const section = page.locator('.request-editor .settings-section');
      expect(await section.locator('input.switch').count()).toBe(2);
      expect(await section.locator('.dropdown').count()).toBe(3);
      expect(await section.locator('select').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('全局缩进宽度落库后作用于之后的响应', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByTestId('settings-panel').waitFor();

      // 缺省：Auto + 2 空格
      expect(await page.getByTestId('format-detection').getAttribute('data-value')).toBe('auto');
      expect(await page.getByTestId('indent-width').getAttribute('data-value')).toBe('2');

      await page.getByTestId('indent-width').click();
      await page.getByRole('option', { name: '4 空格' }).click();

      // 设置面在改动停止后自动落库
      await page.waitForFunction(
        () =>
          (globalThis as never as { __settings: Record<string, string> }).__settings[
            'response_presentation:indent_width'
          ] === '4',
        undefined,
        { timeout: 5_000 },
      );

      await page.keyboard.press('Escape');
      await send(page);

      expect(await waitBody(page, '{\n    "a": 1\n}')).toContain('    "a": 1');
    } finally {
      await page.close();
    }
  });
});
