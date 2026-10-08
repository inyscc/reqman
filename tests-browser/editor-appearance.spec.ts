// 编辑器外观在真实引擎里的表现（change: add-editor-appearance-settings，
// 任务 3.1 / 3.2 / 4.2 / 4.3）。
//
// 为什么必须真浏览器：字号一头落在 Monaco 的 `.view-lines` 上、一头落在纯文本正文的
// `pre` 上，「同一份内容两条渲染路径字号一致」只能在真引擎里量；而「改动立即作用于已经
// 打开的编辑面」与「重载后读回」也要真实的页面生命周期。
//
// 浏览器从 `./browser` 取（自带 Chromium → 本机 Chrome → 本机 Edge 的退回链），
// 本仓库严禁安装 Playwright 自带的 Chromium。假后端与 response-format-selector 同源，
// 唯一差别：settings 落在 localStorage 上，这样 reload 之后还能读回。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__settings = JSON.parse(localStorage.getItem('__settings') || '{}');
// 待发响应也落 localStorage：reload 之后 init script 会重跑，只放在内存里会被清空
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
      // 正文是 raw + JSON：请求 Body 的类型行动作区（含折行开关）才会渲染出来
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
      case 'curl_export':
        // 命令由用例注入（默认是一条短命令）：验证 cURL 文本块的呈现时用超长单行命令
        return {
          command: window.__curlCommand || "curl -X GET 'https://api.test/1'",
          parts: window.__curlParts || ["curl -X GET", "'https://api.test/1'"],
          contains_secret: false,
          warnings: []
        };
      case 'settings_get':
        // 门禁默认放行：与其它浏览器用例同一约定，否则发送会停在确认对话框上
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
        // 需要观察「发送进行中」的用例在此之前设上延迟；不设则立即返回
        if (window.__sendDelay) {
          await new Promise(function (resolve) { setTimeout(resolve, window.__sendDelay); });
        }
        var next = window.__responses.shift();
        __storeQueue();
        return next;
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
    // 端口避开 1420（tauri dev）与 5192–5200、5204（其它浏览器用例）
    server: { port: 5201, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5201}`;
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
    size_limit_bytes: 50 * 1024 * 1024,
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
      // 当前页与后续 reload 都要拿到这份队列
      (globalThis as never as { __responses: unknown[] }).__responses = list as never[];
      localStorage.setItem('__responses', JSON.stringify(list));
    },
    responses,
  );
  return page;
}

/** 打开请求并发送一次。 */
async function send(page: Page) {
  await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
  await page.getByLabel('请求地址').waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '发送', exact: true }).click({ timeout: 10_000 });
  await page.getByTestId('status').waitFor({ timeout: 10_000 });
}

/** 打开设置模态。 */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByTestId('settings-panel').waitFor();
}

/** 等某一项落库（设置面在改动停止后自动落库）。 */
async function waitStored(page: Page, key: string, value: string) {
  await page.waitForFunction(
    ({ key, value }) =>
      (JSON.parse(localStorage.getItem('__settings') ?? '{}') as Record<string, string>)[key] ===
      value,
    { key, value },
    { timeout: 5_000 },
  );
}

/**
 * 在通用下拉里选一项。
 *
 * 带重试：设置面在改动停止后会自动落库，紧接着 `load()` 回来重渲染一次；菜单若跨在这次
 * 重渲染上，展开的选项会被卸载（Playwright 看到元素 detached）。重开一次即可，不必靠
 * 固定等待去赌时序。超时也显式给短值，失败时能一眼看出卡在哪一步。
 */
async function pickOption(page: Page, testId: string, option: string | RegExp, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.getByTestId(testId).click({ timeout: 5_000 });
    try {
      await page.getByRole('option', { name: option }).click({ timeout: 2_000 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await page.waitForTimeout(400);
    }
  }
}

/** 响应正文当前的字号与字体族（Monaco 取行元素，纯文本降级 / Hex 取 pre 自身）。 */
async function bodyTypography(page: Page) {
  // Monaco 是异步渲染的：正文画出来之前量不到 `.view-line`（pre 那条路是同步的）
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-testid="response-body"]');
      if (!host) return false;
      return host.tagName === 'PRE' || Boolean(host.querySelector('.view-lines .view-line'));
    },
    undefined,
    { timeout: 10_000 },
  );

  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="response-body"]') as HTMLElement | null;
    if (!host) return null;
    const target =
      host.tagName === 'PRE'
        ? host
        : (host.querySelector('.view-lines .view-line') as HTMLElement | null);
    if (!target) return null;
    const style = getComputedStyle(target);
    return { fontSize: style.fontSize, fontFamily: style.fontFamily };
  });
}

/** 等正文渲染出文本再读它（Monaco 是异步渲染的，直接读会拿到空串）。 */
async function readRenderedBody(page: Page): Promise<string> {
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
        ? (host.textContent ?? '')
        : Array.from(host.querySelectorAll('.view-lines .view-line'))
            .map((line) => line.textContent ?? '')
            .join('\n');
    return raw.replace(/\u00a0/g, ' ');
  });
}

/** 文档根上的等宽变量（非 Monaco 的等宽面吃这两个值）。 */
async function rootMonoVars(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      fontFamily: style.getPropertyValue('--font-mono').trim(),
      fontSize: style.getPropertyValue('--text-mono').trim(),
    };
  });
}

describe('编辑器外观（真实引擎）', () => {
  it('设置面五项是行式列表：输入框 + 数值框 + 下拉 + 开关，缺省即设计值', async () => {
    const page = await openApp([]);
    try {
      await openSettings(page);

      const section = page.getByTestId('editor-appearance');
      await section.waitFor();

      // 名字在左、控件在右的五项，且没有原生 select / 单选按钮（互斥项走通用下拉）
      expect(await section.locator('.settings-row').count()).toBe(5);
      expect(await section.locator('select').count()).toBe(0);
      expect(await section.locator('input[type="radio"]').count()).toBe(0);
      expect(await section.locator('.dropdown').count()).toBe(1);
      // 换行是布尔项：一个开关，且缺省为开
      expect(await section.locator('input.switch').count()).toBe(1);
      expect(await page.getByTestId('editor-wrap').isChecked()).toBe(true);

      // 缺省：系统等宽栈（示例收在 placeholder 里）/ 12px / 缩进 4 / 空格
      const family = page.getByTestId('editor-font-family');
      // 空字体栈按「未设置」处理，读回即缺省——因此框里就是那条系统栈；
      // 同一串也收在 placeholder 里（清空输入框时能看到示例）
      expect(await family.inputValue()).toContain('Cascadia Mono');
      expect(await family.getAttribute('placeholder')).toContain('Cascadia Mono');
      expect(await page.getByTestId('editor-font-size').inputValue()).toBe('12');
      expect(await page.getByTestId('editor-indent-count').inputValue()).toBe('4');
      expect(await page.getByTestId('editor-indent-type').getAttribute('data-value')).toBe('space');

      // 行内不出现解释性句子
      expect(await section.locator('.settings-hint').count()).toBe(0);

      // 控件按内容定宽、右缘对齐：字体框最大（要写得下一整条字体栈），数值框一律以
      // 「缩进数」为准（有单位的字号与它一样长），下拉贴着右缘（菜单也从右缘展开）
      const boxes = await page.evaluate(() => {
        const round = (value: number) => Math.round(value);
        const box = (node: HTMLElement | null) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { width: round(rect.width), right: round(rect.right) };
        };
        // 字号是「数值 + 单位」同框：量外框（单位挤在里面，不把整格撑宽）
        const sizeField = document.querySelector(
          '[data-testid="editor-font-size"]',
        ) as HTMLElement | null;

        return {
          font: box(document.querySelector('[data-testid="editor-font-family"]') as HTMLElement),
          size: box(sizeField?.closest('.unit-field') as HTMLElement | null),
          count: box(document.querySelector('[data-testid="editor-indent-count"]') as HTMLElement),
          type: box(document.querySelector('[data-testid="editor-indent-type"]') as HTMLElement),
        };
      });

      expect(boxes.size?.width, '字号（含单位）应与缩进数一样长').toBe(boxes.count?.width);
      expect(boxes.count?.width).toBeLessThan(boxes.font?.width ?? 0);
      expect(boxes.type?.right).toBe(boxes.font?.right);
    } finally {
      await page.close();
    }
  });

  it('改字号立即作用于已经打开的响应正文，不需要重载', async () => {
    const page = await openApp([payload({ content_type: 'application/json', body_text: '{"a":1}' })]);
    try {
      await send(page);
      // 缺省 12px（与纯文本面同一档）
      expect((await bodyTypography(page))?.fontSize).toBe('12px');

      await openSettings(page);
      await page.getByTestId('editor-font-size').fill('14', { timeout: 5_000 });
      await waitStored(page, 'editor_appearance:font_size', '14');

      // 模态仍开着，正文编辑面在它后面活着——此刻就该是新字号
      expect((await bodyTypography(page))?.fontSize).toBe('14px');
      expect((await rootMonoVars(page)).fontSize).toBe('14px');
    } finally {
      await page.close();
    }
  });

  it('同一份内容跨两条渲染路径字号一致（结构化正文 ↔ Hex）', async () => {
    const page = await openApp([payload({ content_type: 'text/plain', body_text: 'hello' })]);
    try {
      await send(page);

      const structured = await bodyTypography(page);
      expect(structured?.fontSize).toBe('12px');

      // Hex 走的是 pre.body 这条纯文本路径：与上面的编辑面同族同号。
      // 不必另外等元素——bodyTypography 会等到正文真的画出来（hex 时宿主自己就是 pre）。
      await pickOption(page, 'response-format', /^Hex/);

      const plain = await bodyTypography(page);
      expect(plain?.fontSize, '同一份内容不该在两条路径之间换字号').toBe(structured?.fontSize);
      expect(plain?.fontFamily).toContain('Cascadia Mono');
    } finally {
      await page.close();
    }
  });

  it('外观跨重载保留，且重载后仍落到编辑面上', async () => {
    const page = await openApp([payload({ content_type: 'application/json', body_text: '{"a":1}' })]);
    try {
      await openSettings(page);

      // 先动下拉、再填输入框：改字号会改等宽面的度量、让模态正文滚动一下，而
      //「菜单之外的容器滚动」正是 useMenuDismiss 的关闭条件之一——顺序反了会关掉刚展开的菜单
      await pickOption(page, 'editor-indent-type', 'Tab');
      await waitStored(page, 'editor_appearance:indent_type', 'tab');

      await page.getByTestId('editor-font-size').fill('15', { timeout: 5_000 });
      await waitStored(page, 'editor_appearance:font_size', '15');

      await page.getByTestId('editor-font-family').fill('Menlo, monospace', { timeout: 5_000 });
      await waitStored(page, 'editor_appearance:font_family', 'Menlo, monospace');

      // 折行也一起改掉：它是这一节的第五项，重载后应仍显示所设的值
      await page.getByTestId('editor-wrap').click();
      await waitStored(page, 'editor_appearance:wrap', 'false');

      // 启动时读回一次即注入（App 的那条读回路由）
      await page.reload({ waitUntil: 'load' });
      await page.getByTestId('workspace-tree').waitFor({ timeout: 15_000 });

      const vars = await rootMonoVars(page);
      expect(vars.fontSize).toBe('15px');
      expect(vars.fontFamily).toBe('Menlo, monospace');

      // 读回的值也要真的到编辑面上（不是只有 CSS 变量变了）
      await send(page);
      expect((await bodyTypography(page))?.fontSize).toBe('15px');

      // 五项在重载后仍显示所设的值
      await openSettings(page);
      expect(await page.getByTestId('editor-font-size').inputValue()).toBe('15');
      expect(await page.getByTestId('editor-indent-type').getAttribute('data-value')).toBe('tab');
      expect(await page.getByTestId('editor-wrap').isChecked()).toBe(false);
      await page.keyboard.press('Escape');
    } finally {
      await page.close();
    }
  });

  it('缩进是全应用唯一的一份：改编辑器设置即改变格式化输出', async () => {
    const page = await openApp([payload({ content_type: 'application/json', body_text: '{"a":1}' })]);
    try {
      await openSettings(page);

      // 界面上不存在第二处缩进设置
      expect(await page.getByTestId('indent-width').count()).toBe(0);

      // 先动下拉、再填输入框：改等宽面的度量会让模态正文滚动一下，而「菜单之外的容器滚动」
      // 正是 useMenuDismiss 的关闭条件之一——顺序反了会关掉刚展开的菜单
      await pickOption(page, 'editor-indent-type', 'Tab');
      await waitStored(page, 'editor_appearance:indent_type', 'tab');

      await page.getByTestId('editor-indent-count').fill('8', { timeout: 5_000 });
      await waitStored(page, 'editor_appearance:indent_count', '8');

      // 格式化输出按同一份设置：Tab 档每层一个制表符（spec: code-editors「等宽面的外观与缩进」）
      // 格式化输出按同一份设置重排：Tab 档一层缩进占 tabSize 列（= 缩进数 8）。
      // 注意 Monaco 把行内空白按**列**渲染，DOM 里读不出「1 个制表符」与「8 个空格」的区别；
      // 制表符本身由 `indentUnit` / `prettyJson` / `formatRawBody` 的单测保证。
      await page.keyboard.press('Escape');
      await send(page);
      const text = await readRenderedBody(page);
      expect(text, `格式化输出应按 8 列缩进，实际：${JSON.stringify(text)}`).toContain(
        '        "a": 1',
      );
    } finally {
      await page.close();
    }
  });
});

/**
 * 折行在真实引擎里的表现（spec: ui-layout「折行」）。
 *
 * 为什么必须真浏览器：悬浮开关的显隐是 CSS 悬停态（`:hover` / `:focus-visible`）与
 * `pointer-events` 的组合，排版是否被它推动也只能量真实几何。
 */
describe('折行（真实引擎）', () => {
  /** 悬浮开关的可见性：Playwright 的可见性判断不看 opacity，因此直接量它。 */
  function wrapOpacity(page: Page) {
    return page.evaluate(() => {
      const node = document.querySelector('[data-testid="response-wrap"]');
      return node ? getComputedStyle(node).opacity : null;
    });
  }

  /** 等悬浮开关的透明度变成给定值。 */
  function waitWrapOpacity(page: Page, value: string) {
    return page.waitForFunction(
      (expected) =>
        getComputedStyle(document.querySelector('[data-testid="response-wrap"]') as HTMLElement)
          .opacity === expected,
      value,
      { timeout: 5_000 },
    );
  }

  /** 响应正文区的几何：宽度、可见行数与滚动位置（显隐不该改变它们）。 */
  function bodyLayout(page: Page) {
    return page.evaluate(() => {
      const host = document.querySelector('[data-testid="response-body"]') as HTMLElement;
      const body = host.closest('.pane-body') as HTMLElement;
      return {
        width: Math.round(host.getBoundingClientRect().width),
        lines: body.querySelectorAll('.view-line').length,
        scrollTop: body.scrollTop,
      };
    });
  }

  /** 响应面板的视图标签（请求编辑器里有同名标签，因此必须限定在响应区内）。 */
  function responseTab(page: Page, name: string) {
    return page.locator('.response-region').getByRole('button', { name, exact: true });
  }

  /** 请求编辑器的内层标签（与响应面板的同名标签区分开）。 */
  function requestTab(page: Page, name: string) {
    return page.locator('.request-editor').getByRole('button', { name, exact: true });
  }

  it('响应区开关：停在工具条最右端、悬停才显形、只在 Body 视图出现、显隐不推动排版', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await send(page);
      await page.getByTestId('response-body').waitFor();
      // Monaco 的行是异步画出来的：先等它画出内容，否则第一次几何测量会读到 0 行
      await page.waitForFunction(
        () => {
          const host = document.querySelector('[data-testid="response-body"]');
          return host ? host.querySelectorAll('.view-line').length > 0 : false;
        },
        undefined,
        { timeout: 10_000 },
      );

      // 指针不在响应区：不可见（也不吃指针事件）
      expect(await wrapOpacity(page)).toBe('0');

      await page.locator('.response-region').hover();
      await waitWrapOpacity(page, '1');

      // 它是图标控件：控件里是一枚绘制，没有可见文字，但有可读的名称
      const chip = page.getByTestId('response-wrap');
      expect(await chip.locator('svg').count(), '悬浮开关应以图标呈现').toBe(1);
      expect(await chip.textContent(), '图标控件不该有可见文字').toBe('');
      expect(
        await page.locator('.response-region').getByRole('button', { name: '折行', exact: true }).count(),
        '图标控件应带可供辅助技术读取的名称',
      ).toBe(1);

      // 位置：停在正文工具条那一行、且排在该行最后——也就是响应区的最右端，
      // 因此它不压在正文之上（spec: ui-layout「折行」的「开关停在工具条最右端」）
      const place = await page.evaluate(() => {
        const node = document.querySelector('[data-testid="response-wrap"]') as HTMLElement;
        const bar = document.querySelector('.response-view-bar') as HTMLElement;
        return {
          inToolbar: bar.contains(node),
          last: bar.lastElementChild === node,
          overlaysBody: (document.querySelector('.response-body-area') as HTMLElement).contains(node),
          rightGap: Math.round(bar.getBoundingClientRect().right - node.getBoundingClientRect().right),
        };
      });
      expect(place.inToolbar, '开关应停在正文工具条里').toBe(true);
      expect(place.last, '开关应是工具条那一行的最后一项（最右端）').toBe(true);
      expect(place.overlaysBody, '开关不该压在正文之上').toBe(false);
      expect(place.rightGap, '开关的右边缘应与工具条右边缘齐平').toBeLessThanOrEqual(1);

      const shown = await bodyLayout(page);

      // 移出响应区后隐去，且排版完全没动
      await page.mouse.move(4, 4);
      await waitWrapOpacity(page, '0');
      const hidden = await bodyLayout(page);
      expect(
        hidden,
        `显隐不该改变正文区的宽度、行数与滚动位置：显示时 ${JSON.stringify(shown)}，隐去后 ${JSON.stringify(hidden)}`,
      ).toEqual(shown);

      // 只在 Body 视图出现：切到 Headers 就不该再出现，切回 Body 又回来
      await responseTab(page, 'Headers').click();
      expect(await page.getByTestId('response-wrap').count()).toBe(0);
      await responseTab(page, 'Body').click();
      expect(await page.getByTestId('response-wrap').count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('响应区开关键盘可达：焦点落到它上面时可见且可用', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await send(page);
      await page.getByTestId('response-body').waitFor();

      // 从它前一个可聚焦元素（呈现格式下拉）按下 Tab：键盘导致的焦点满足 :focus-visible
      await page.getByTestId('response-format').focus();
      await page.keyboard.press('Tab');

      expect(
        await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
        '悬浮开关应能被键盘焦点命中',
      ).toBe('response-wrap');
      await waitWrapOpacity(page, '1');

      // 可用：回车即切换，并计入未保存
      await page.keyboard.press('Enter');
      await page.getByText('未保存').waitFor({ timeout: 5_000 });
      expect(await page.getByTestId('response-wrap').getAttribute('aria-pressed')).toBe('false');
    } finally {
      await page.close();
    }
  });

  it('长字段值折行后可完整阅读；关掉折行则回到横向滚动', async () => {
    const longValue = `{"field":"${'x'.repeat(800)}"}`;
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: longValue }),
    ]);
    try {
      await send(page);

      const measure = () =>
        page.evaluate(() => {
          const host = document.querySelector('[data-testid="response-body"]') as HTMLElement;
          return { lines: host.querySelectorAll('.view-line').length };
        });

      // 折行开启（缺省）：那条很长的逻辑行被折成多个可见行，不需要横向滚动
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="response-body"] .view-line').length > 3,
        undefined,
        { timeout: 10_000 },
      );
      const wrapped = await measure();
      expect(wrapped.lines, '一条很长的逻辑行应被折成多个可见行').toBeGreaterThan(3);
      // 「不需要横向滚动」这件事在 DOM 上量不出来：Monaco 的横向滚动是虚拟的
      // （`.monaco-scrollable-element` 的 scrollWidth 是 2^24 的哨兵值，折与不折都一样）。
      // 折行本身由 `wordWrap` 选项表达，该选项在 `code-surface.spec.ts` 里被直接断言。

      // 用悬浮开关关掉折行：可见行数回落到逻辑行数，横向滚动出现
      await page.locator('.response-region').hover();
      await waitWrapOpacity(page, '1');
      await page.getByTestId('response-wrap').click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="response-body"] .view-line').length <= 3,
        undefined,
        { timeout: 10_000 },
      );

      const nowrap = await measure();
      expect(nowrap.lines, '关掉折行后应回到逻辑行数').toBeLessThan(wrapped.lines);
    } finally {
      await page.close();
    }
  });

  it('两处开关与请求 Settings 行是同一份取值', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await send(page);
      await page.getByTestId('response-body').waitFor();

      // 请求侧类型行的开关在 Body 标签页里
      await requestTab(page, 'Body').click();
      // 缺省跟随全局（全局缺省开启）
      expect(await page.getByTestId('body-wrap').getAttribute('aria-pressed')).toBe('true');

      // 1) 请求侧类型行的开关
      await page.getByTestId('body-wrap').click();
      expect(await page.getByTestId('body-wrap').getAttribute('aria-pressed')).toBe('false');
      await page.getByText('未保存').waitFor({ timeout: 5_000 });

      // 2) 请求 Settings 行显示同一个值
      await requestTab(page, 'Settings').click();
      expect(await page.getByTestId('request-wrap-lines').getAttribute('data-value')).toBe('off');

      // 3) 响应区悬浮开关：此刻是关的，点一下变开，两处同时为开
      await page.locator('.response-region').hover();
      await waitWrapOpacity(page, '1');
      expect(await page.getByTestId('response-wrap').getAttribute('aria-pressed')).toBe('false');
      await page.getByTestId('response-wrap').click();

      expect(await page.getByTestId('response-wrap').getAttribute('aria-pressed')).toBe('true');
      await requestTab(page, 'Body').click();
      expect(await page.getByTestId('body-wrap').getAttribute('aria-pressed')).toBe('true');
      await requestTab(page, 'Settings').click();
      expect(await page.getByTestId('request-wrap-lines').getAttribute('data-value')).toBe('on');
    } finally {
      await page.close();
    }
  });

  it('cURL 文本块始终软折行：超长单行命令不横向溢出，动作行不提供折行开关', async () => {
    const page = await openApp([]);
    try {
      // 单行布局下整条命令常是一个不含空格的超长 token：只按词边界折行照样会横向溢出
      const long = 'x'.repeat(600);
      await page.evaluate((value) => {
        const g = globalThis as never as { __curlParts: string[]; __curlCommand: string };
        g.__curlParts = ['curl -X GET', `'https://api.test/${value}'`];
        g.__curlCommand = g.__curlParts.join(' ');
      }, long);

      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click({ timeout: 10_000 });
      await page.locator('.request-editor').getByRole('button', { name: 'cURL', exact: true }).click();

      const field = page.getByLabel('curl 命令');
      await field.waitFor({ timeout: 10_000 });

      const metrics = await field.evaluate((node) => {
        const el = node as HTMLTextAreaElement;
        return {
          whiteSpace: getComputedStyle(el).whiteSpace,
          overflowX: el.scrollWidth - el.clientWidth,
        };
      });
      expect(metrics.whiteSpace).toBe('pre-wrap');
      expect(metrics.overflowX, '超长命令应折行而不是横向滚动').toBeLessThanOrEqual(1);
      // 折行只改呈现：文本内容一字不改
      expect(await field.inputValue()).toContain(long);

      // 动作行只有「重新生成 / 复制」，且文本块上不存在折行开关
      const actions = page.locator('.curl-block .curl-actions');
      expect(await actions.locator('button').count()).toBe(2);
      expect(
        await page.locator('.curl-block').getByRole('button', { name: '折行', exact: true }).count(),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('发送进行中两处开关都不响应', async () => {
    const page = await openApp([
      payload({ content_type: 'application/json', body_text: '{"a":1}' }),
    ]);
    try {
      await send(page);
      await requestTab(page, 'Body').click();
      await page.getByTestId('response-body').waitFor();
      expect(await page.getByTestId('body-wrap').isDisabled()).toBe(false);

      // 让假后端慢下来，好停在「发送进行中」
      await page.evaluate(() => {
        (globalThis as never as { __sendDelay: number }).__sendDelay = 1_200;
      });
      await page.getByTestId('body-wrap').click(); // 先关掉折行，之后断言它没被改动
      await page.getByText('未保存').waitFor({ timeout: 5_000 });

      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="body-wrap"]') as HTMLButtonElement)?.disabled === true,
        undefined,
        { timeout: 5_000 },
      );

      expect(await page.getByTestId('body-wrap').isDisabled()).toBe(true);
      expect(await page.getByTestId('response-wrap').isDisabled()).toBe(true);

      // 发送结束后恢复可操作，且取值没被动过
      await page.getByTestId('status').waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="body-wrap"]') as HTMLButtonElement)?.disabled === false,
        undefined,
        { timeout: 10_000 },
      );
      expect(await page.getByTestId('body-wrap').getAttribute('aria-pressed')).toBe('false');
    } finally {
      await page.close();
    }
  });
});
