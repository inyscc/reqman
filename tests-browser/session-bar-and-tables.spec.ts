// 会话标签行的溢出行为与表格表头吸顶在真实引擎里的表现
// （change: rework-request-band-env-and-tables，任务 1.1 / 1.2）。
//
// 为什么要真浏览器：这两条都是**几何**结论——「表头是否钉在滚动容器顶部」与
// 「标签超宽时右侧控件是否被挤出可见区」在 jsdom / happy-dom 里没有布局可言，
// 只能给出假结论。
//
// 浏览器从 `./browser` 取（自带 Chromium → 本机 Chrome → 本机 Edge 的退回链），
// 本仓库严禁安装 Playwright 自带的 Chromium。
//
// 应用在没有 Tauri 的环境里起不来（`__TAURI_INTERNALS__` 不存在），因此这里在文档
// 起点注入一个最小的假后端——只满足启动与渲染，不碰任何脚本/网络能力。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

/** 树里放 12 条请求：够把标签栏撑到超宽。 */
const REQUEST_COUNT = 12;

const FAKE_TAURI = `
window.__TAURI_INTERNALS__ = {
  transformCallback: function (callback) {
    var id = Math.floor(Math.random() * 1000000);
    window['_' + id] = callback;
    return id;
  },
  unregisterCallback: function (id) { delete window['_' + id]; },
  convertFileSrc: function (path) { return path; },
  invoke: async function (cmd) {
    var auth = { kind: 'inherit', basic: null, bearer: null, api_key: null };
    var workspace = { id: 'w1', name: '探针工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '探针集合', auth: auth,
      pre_request_script: null, test_script: null, sort_order: 0
    };
    function request(index) {
      var id = 'r' + index;
      return {
        id: id, collection_id: 'c1', folder_id: null, name: '请求 ' + index,
        method: 'GET', url: 'https://api.test/' + index + '?a=1',
        params: [{ key: 'a', value: '1', enabled: true }],
        headers: [],
        body: { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null },
        auth: auth,
        settings: {
          timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
          http_version: 'auto', encoding: null, proxy: null
        },
        pre_request_script: null, test_script: null, sort_order: 0
      };
    }
    var nodes = [];
    for (var i = 1; i <= ${REQUEST_COUNT}; i += 1) {
      nodes.push({
        kind: 'request', id: 'r' + i, name: '请求 ' + i, sort_order: i,
        children: [], request: request(i)
      });
    }

    var environment = {
      id: 'e1', workspace_id: 'w1', name: '国内环境', is_active: true,
      proxy: null, sort_order: 0
    };
    var plainVar = {
      id: 'v1', scope: 'environment', owner_id: 'e1', name: 'host', is_secret: false,
      initial: { state: 'value', value: 'https://api.test' },
      current: { state: 'value', value: 'https://api.test' }
    };
    // secret 的当前值本身就是掩码文本（明文只能经「揭示」取得），此处只要一行可渲染
    var secretVar = {
      id: 'v2', scope: 'environment', owner_id: 'e1', name: 'token', is_secret: true,
      initial: { state: 'value', value: '••••••' },
      current: { state: 'value', value: '••••••' }
    };
    var globalVar = {
      id: 'v3', scope: 'global', owner_id: 'w1', name: 'base', is_secret: false,
      initial: { state: 'value', value: 'https://api.test' },
      current: { state: 'value', value: 'https://api.test' }
    };

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree': return [{ collection: collection, children: nodes }];
      case 'environment_list': return [environment];
      case 'environment_active': return environment;
      case 'globals_list': return [globalVar];
      case 'variable_list': return [plainVar, secretVar];
      case 'collection_get': return collection;
      case 'request_get': return request(1);
      case 'settings_get': return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/1?a=1', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], used: [], masked: false, insecure_warning: false
        };
      case 'curl_export':
        return {
          command: "curl -X GET 'https://api.test/1?a=1'",
          contains_secret: false,
          warnings: []
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
    // 端口避开 1420（tauri dev）、5196（tree-expansion）、5197（host-injection）、
    // 5198（ghost-row）、5199（script-runtime）
    server: { port: 5195, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5195}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').waitFor();
  return page;
}

describe('表头吸顶（真实引擎）', () => {
  it('表体滚动时表头钉在容器顶部，且表头表面不透明', async () => {
    const page = await openApp({ width: 1000, height: 420 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      // 把表格撑到必须滚动：反复在幽灵行里写一行再回车
      for (let index = 0; index < 16; index += 1) {
        const ghost = page.getByLabel('新增行的名称');
        await ghost.click();
        await page.keyboard.type(`k${index}`);
        await page.keyboard.press('Enter');
      }

      // 滚动容器是键值表自己的满高容器（change: fill-request-editor-panes），
      // 不再是 .pane-body——正文区在铺满模式下不滚，滚动发生在表格容器内部。
      const pane = page.locator('.request-editor .table-scroll').first();
      const scrollable = await pane.evaluate((node) => node.scrollHeight - node.clientHeight);
      expect(scrollable, '表格没有撑到需要滚动，本用例无法验证吸顶').toBeGreaterThan(40);

      const geometry = await page.evaluate(() => {
        const body = document.querySelector('.request-editor .table-scroll') as HTMLElement;
        const header = document.querySelector('.request-editor thead th') as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        return {
          paneTop: round(body.getBoundingClientRect().top),
          headerTop: round(header.getBoundingClientRect().top),
          headerBackground: getComputedStyle(header).backgroundColor,
          headerPosition: getComputedStyle(header).position,
        };
      });

      await pane.evaluate((node) => {
        node.scrollTop = 200;
      });

      const after = await page.evaluate(() => {
        const body = document.querySelector('.request-editor .table-scroll') as HTMLElement;
        const header = document.querySelector('.request-editor thead th') as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        return {
          scrollTop: round(body.scrollTop),
          paneTop: round(body.getBoundingClientRect().top),
          headerTop: round(header.getBoundingClientRect().top),
        };
      });

      expect(after.scrollTop, '滚动没有生效').toBeGreaterThan(40);
      expect(
        Math.abs(after.headerTop - after.paneTop),
        `表头没有钉在容器顶部：${JSON.stringify({ before: geometry, after })}`,
      ).toBeLessThanOrEqual(2);
      expect(geometry.headerPosition).toBe('sticky');
      expect(
        geometry.headerBackground,
        '表头表面是透明的，滚过的行会从它下面透出来',
      ).not.toBe('rgba(0, 0, 0, 0)');
    } finally {
      await page.close();
    }
  });
});

describe('通栏请求带（真实引擎）', () => {
  it('地址栏横跨主区整宽，拖动分隔线不改变它的宽度', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      const width = (selector: string) =>
        page.evaluate((target) => {
          const node = document.querySelector(target) as HTMLElement | null;
          return node ? Math.round(node.getBoundingClientRect().width * 100) / 100 : null;
        }, selector);

      const mainWidth = await width('.main');
      const bandWidth = await width('.request-top');
      const regionBefore = await width('.request-region');

      expect(mainWidth).not.toBeNull();
      expect(
        Math.abs((bandWidth as number) - (mainWidth as number)),
        `请求带没有横跨整宽：主区 ${mainWidth}，请求带 ${bandWidth}`,
      ).toBeLessThanOrEqual(1);

      // 拖动分隔线：分栏比例变化，请求带宽度不变
      const handle = page.getByTestId('split-handle');
      const box = await handle.boundingBox();
      if (!box) throw new Error('分隔线没有可见的命中区');
      const centerY = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, centerY);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 140, centerY, { steps: 6 });
      await page.mouse.up();

      const bandAfter = await width('.request-top');
      const regionAfter = await width('.request-region');

      expect(
        Math.abs((regionAfter as number) - (regionBefore as number)),
        '拖动没有改变分栏比例，本用例无法验证「拖动不影响请求带」',
      ).toBeGreaterThan(20);
      expect(
        Math.abs((bandAfter as number) - (bandWidth as number)),
        `拖动分栏改变了请求带宽度：拖动前 ${bandWidth}，拖动后 ${bandAfter}`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it('请求面板头只承载身份：没有请求级操作按钮，面包屑不随指针跳动', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      const snapshot = () =>
        page.evaluate(() => {
          const round = (value: number) => Math.round(value * 100) / 100;
          const header = document.querySelector(
            '[data-testid="request-panel-header"]',
          ) as HTMLElement;
          const crumb = document.querySelector('.crumb') as HTMLElement;
          return {
            buttons: Array.from(header.querySelectorAll('button')).map(
              (node) => node.textContent ?? '',
            ),
            crumbLeft: round(crumb.getBoundingClientRect().left),
          };
        });

      // 指针移到别处
      await page.mouse.move(5, 5);
      const before = await snapshot();
      // 指针移进请求带（地址栏那一行同样算请求带内）
      await page.hover('.request-toolbar');
      const after = await snapshot();

      // 面板头里没有任何请求级操作按钮（复制/删除在集合树，cURL 在标签里）
      expect(after.buttons).toEqual([]);
      // 指针进出不改变面包屑的位置
      expect(
        Math.abs(after.crumbLeft - before.crumbLeft),
        `指针进出引起了面包屑水平跳动：${JSON.stringify({ before, after })}`,
      ).toBeLessThanOrEqual(0.5);
    } finally {
      await page.close();
    }
  });
});

describe('会话标签行的溢出（真实引擎）', () => {
  it('标签超宽时标签栏自己滚动，环境选择器与窗口按钮完整可见', async () => {
    const page = await openApp({ width: 1000, height: 640 });
    try {
      for (let index = 1; index <= REQUEST_COUNT; index += 1) {
        await page.getByRole('button', { name: `GET 请求 ${index}`, exact: true }).click();
      }
      await page.getByLabel('请求地址').waitFor();

      const state = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const tabs = document.querySelector('.session-tabs') as HTMLElement;
        const select = document.querySelector('.env-select') as HTMLElement;
        const controls = document.querySelector('.window-controls') as HTMLElement;
        const rect = (node: HTMLElement) => {
          const box = node.getBoundingClientRect();
          return { left: round(box.left), right: round(box.right), width: round(box.width) };
        };
        return {
          tabCount: document.querySelectorAll('[data-testid="session-tab"]').length,
          tabScrollWidth: tabs.scrollWidth,
          tabClientWidth: tabs.clientWidth,
          select: rect(select),
          controls: rect(controls),
          viewportWidth: window.innerWidth,
        };
      });

      expect(state.tabCount).toBe(REQUEST_COUNT);
      expect(state.tabScrollWidth, '标签没有超出可用宽度，本用例无法验证溢出').toBeGreaterThan(
        state.tabClientWidth,
      );
      expect(state.select.width).toBeGreaterThan(0);
      expect(state.controls.width).toBeGreaterThan(0);
      expect(state.select.right).toBeLessThanOrEqual(state.viewportWidth);
      expect(state.controls.right).toBeLessThanOrEqual(state.viewportWidth);
      expect(state.controls.left).toBeGreaterThanOrEqual(state.select.right - 1);
    } finally {
      await page.close();
    }
  });

  it('标签被挤到最窄时，关闭按钮仍在标签内（× 不溢出）', async () => {
    const page = await openApp({ width: 1000, height: 640 });
    try {
      for (let index = 1; index <= REQUEST_COUNT; index += 1) {
        await page.getByRole('button', { name: `GET 请求 ${index}`, exact: true }).click();
      }
      await page.getByLabel('请求地址').waitFor();

      // 逐个比：每个标签的关闭位必须落在标签盒内（原先 min-width: 0 会让标签被压到
      // 内容以下，× 于是跑到标签外面）
      const escaping = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.session-tab'));
        return rows
          .map((tab) => {
            const close = tab.querySelector('.session-tab-close') as HTMLElement | null;
            if (!close) return null;
            return Math.round(close.getBoundingClientRect().right - tab.getBoundingClientRect().right);
          })
          .filter((value): value is number => value !== null && value > 1);
      });

      expect(escaping).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describe('树滚动条不占行宽（真实引擎）', () => {
  it('滚动条出现与否，行右端的 ⋯ 一动不动', async () => {
    const page = await openApp({ width: 1000, height: 360 });
    try {
      const measure = async () => {
        // 悬停第一行让右端的「⋯」出现，再量它的右缘
        await page.locator('.tree-root .node').first().hover();
        return page.evaluate(() => {
          const root = document.querySelector('.tree-root') as HTMLElement;
          const more = document.querySelector('.node-more') as HTMLElement | null;
          return {
            // 占位型滚动条会让 offsetWidth 比 clientWidth 大
            gutter: root.offsetWidth - root.clientWidth,
            scrollable: root.scrollHeight > root.clientHeight,
            moreRight: more ? Math.round(more.getBoundingClientRect().right) : null,
            overlay: document.querySelector('[data-testid="overlay-scrollbar"]') !== null,
          };
        });
      };

      // 窗口矮：12 条请求装不下，树必须滚动
      const short = await measure();
      expect(short.scrollable).toBe(true);
      expect(short.gutter, '滚动条占了行宽').toBe(0);
      expect(short.overlay, '没有绘制悬浮滚动条').toBe(true);
      expect(short.moreRight).not.toBeNull();

      // 窗口变高：滚动条消失。行宽与 ⋯ 的位置都必须和刚才一模一样
      await page.setViewportSize({ width: 1000, height: 900 });
      const tall = await measure();
      expect(tall.scrollable).toBe(false);
      expect(tall.moreRight).toBe(short.moreRight);
    } finally {
      await page.close();
    }
  });
});

describe('变量浮层的锚定（真实引擎）', () => {
  it('浮层从会话标签行溢出到内容之上，且没有被裁切', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();
      await page.getByTestId('env-peek-button').click();
      await page.getByTestId('env-peek').waitFor();

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const bar = document.querySelector('.session-bar') as HTMLElement;
        const panel = document.querySelector('[data-testid="env-peek"]') as HTMLElement;
        const barRect = bar.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        // 若会话标签行裁剪溢出，这一处命中的就不会是浮层自己
        const hit = document.elementFromPoint(
          Math.round(panelRect.left + panelRect.width / 2),
          Math.round(barRect.bottom + 10),
        );
        return {
          barBottom: round(barRect.bottom),
          panelBottom: round(panelRect.bottom),
          panelHeight: round(panelRect.height),
          panelWidth: round(panelRect.width),
          hitIsInsidePanel: Boolean(hit && panel.contains(hit)),
        };
      });

      expect(geometry.panelHeight).toBeGreaterThan(120);
      expect(geometry.panelWidth).toBeGreaterThan(200);
      // 浮层挂在环境选择器按钮下方（不是挂在整行下方），因此它必然越过这一行的下缘
      expect(
        geometry.panelBottom,
        `浮层没有越过会话标签行：${JSON.stringify(geometry)}`,
      ).toBeGreaterThan(geometry.barBottom + 100);
      expect(
        geometry.hitIsInsidePanel,
        `浮层越出会话标签行的那一段被裁掉了：${JSON.stringify(geometry)}`,
      ).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('环境下拉（真实引擎，spec: 会话标签行的全局环境选择器）', () => {
  it('展开菜单不抬高会话标签行，也不向右溢出', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      const before = await page.evaluate(() => {
        const bar = document.querySelector('.session-bar') as HTMLElement;
        return Math.round(bar.getBoundingClientRect().height * 100) / 100;
      });

      await page.getByTestId('env-select-trigger').click();
      await page.getByRole('listbox', { name: '环境' }).waitFor();

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const bar = document.querySelector('.session-bar') as HTMLElement;
        // 菜单 portal 到 body（不再挂在 .env-select 里）：它必须脱离祖先的 overflow，
        // 否则设置模态这类滚动容器会把它裁掉
        const menu = document.querySelector('.dropdown-menu') as HTMLElement;
        const menuRect = menu.getBoundingClientRect();
        return {
          barHeight: round(bar.getBoundingClientRect().height),
          menuRight: round(menuRect.right),
          menuWidth: round(menuRect.width),
          viewportWidth: window.innerWidth,
        };
      });

      expect(geometry.barHeight, '展开菜单把这行抬高了').toBeCloseTo(before, 0);
      expect(geometry.menuWidth).toBeGreaterThan(80);
      expect(geometry.menuRight).toBeLessThanOrEqual(geometry.viewportWidth);
    } finally {
      await page.close();
    }
  });
});

describe('cURL 快照标签（真实引擎）', () => {
  it('复制把命令写进剪贴板，写的是改动后的内容', async () => {
    // 剪贴板权限要显式授予，否则 writeText 会被拒绝——这条用例同时验证
    // 「运行环境里 navigator.clipboard 可用」这个假设（design D5）
    const context = await browser.newContext({
      viewport: { width: 1100, height: 700 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    try {
      await page.addInitScript(FAKE_TAURI);
      await page.goto(origin, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      // cURL 是请求编辑器的一个标签：切过去即生成，不需要再点一次
      await page.getByRole('button', { name: 'cURL', exact: true }).click();
      const field = page.getByLabel('curl 命令');
      await field.waitFor();
      await field.fill('curl -X GET 改过的命令');
      await page.getByTestId('curl-copy').click();

      await page.waitForFunction(
        (expected) => navigator.clipboard.readText().then((text) => text === expected),
        'curl -X GET 改过的命令',
      );
      expect(await page.getByTestId('curl-copy').textContent()).toBe('已复制');
    } finally {
      await context.close();
    }
  });

  it('命令正文铺满正文区：长命令由它自身滚动，不会把分栏区挤没', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();
      await page.getByRole('button', { name: 'cURL', exact: true }).click();
      const field = page.getByLabel('curl 命令');
      await field.waitFor();

      // 塞一段很长的多行命令（60 个请求头）
      await field.fill(Array.from({ length: 60 }, (_, index) => `-H 'X-${index}: v'`).join(' \\\n  '));

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const box = document.querySelector('.curl-command') as HTMLTextAreaElement;
        const body = document.querySelector('.pane-body.fill') as HTMLElement;
        const response = document.querySelector('.response-region') as HTMLElement;
        return {
          fieldHeight: round(box.getBoundingClientRect().height),
          bodyHeight: round(body.getBoundingClientRect().height),
          fieldScrolls: box.scrollHeight > box.clientHeight,
          responseHeight: round(response.getBoundingClientRect().height),
        };
      });

      // 不再是 220px 的高度上限：正文块跟着正文区一起长，滚动发生在它自己内部
      expect(geometry.fieldHeight).toBeGreaterThan(240);
      expect(geometry.fieldHeight).toBeLessThanOrEqual(geometry.bodyHeight);
      expect(geometry.fieldScrolls).toBe(true);
      // 分栏区仍保有可用高度
      expect(geometry.responseHeight).toBeGreaterThan(150);
    } finally {
      await page.close();
    }
  });

  it('动作行在正文上方右对齐，与 Body 行的格式化动作同一款式', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();
      await page.getByRole('button', { name: 'cURL', exact: true }).click();
      await page.getByLabel('curl 命令').waitFor();

      const curl = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const actions = document.querySelector('.curl-actions') as HTMLElement;
        const field = document.querySelector('.curl-command') as HTMLTextAreaElement;
        const copy = document.querySelector('[data-testid="curl-copy"]') as HTMLButtonElement;
        const actionsRect = actions.getBoundingClientRect();
        return {
          actionsBottom: round(actionsRect.bottom),
          fieldTop: round(field.getBoundingClientRect().top),
          copyColor: getComputedStyle(copy).color,
          copyBackground: getComputedStyle(copy).backgroundColor,
          copyClass: copy.className,
          rightGap: round(window.innerWidth - actionsRect.right),
        };
      });

      // 动作行整体在正文上方
      expect(curl.actionsBottom).toBeLessThanOrEqual(curl.fieldTop);
      expect(curl.copyClass).toContain('text-action');

      // 与 Body 类型行的 Minify / Beautify 同一款式：主色文字 + 透明底
      await page.getByRole('button', { name: 'Body', exact: true }).click();
      await page.getByRole('radio', { name: 'raw' }).check();
      // raw 正文已是 Monaco 编辑面（change: monaco-code-editors）：等编辑器渲染出来后
      // 点进去用键盘输入，不能用 fill()（Monaco 的输入不是普通可填控件）
      const bodyEditor = page.locator('.request-region .monaco-editor');
      await bodyEditor.waitFor({ timeout: 15_000 });
      await bodyEditor.click();
      await page.keyboard.type('{"a":1}');
      const body = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="body-beautify"]') as HTMLButtonElement;
        return {
          color: getComputedStyle(button).color,
          background: getComputedStyle(button).backgroundColor,
          class: button.className,
        };
      });

      expect(body.color).toBe(curl.copyColor);
      expect(body.background).toBe(curl.copyBackground);
    } finally {
      await page.close();
    }
  });
});

describe('环境列表的密度（真实引擎）', () => {
  it('行的底色包住行内的 ⋯（三点不是框外的东西）', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('tab', { name: 'Environments' }).click();
      await page.locator('.env-item').first().waitFor();

      // 悬停让「⋯」出现。取第二个行：第一个是 Globals，它没有行操作菜单。
      await page.locator('.env-row').nth(1).hover();

      const geometry = await page.evaluate(() => {
        const row = document.querySelectorAll('.env-row')[1] as HTMLElement;
        const more = row.querySelector('.node-more') as HTMLElement | null;
        const round = (value: number) => Math.round(value * 100) / 100;
        return {
          moreRight: more ? round(more.getBoundingClientRect().right) : null,
          rowRight: round(row.getBoundingClientRect().right),
          background: getComputedStyle(row).backgroundColor,
        };
      });

      expect(geometry.moreRight).not.toBeNull();
      // ⋯ 在被画的底色范围内（底色画在行容器上，而不是只画在选项按钮上）
      expect(geometry.moreRight!).toBeLessThanOrEqual(geometry.rowRight + 0.5);
      expect(geometry.background, '行的表面是透明的，底色没画在行上').not.toBe(
        'rgba(0, 0, 0, 0)',
      );
    } finally {
      await page.close();
    }
  });

  it('悬停环境行不会凭空长出一圈边框', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('tab', { name: 'Environments' }).click();
      await page.locator('.env-item').first().waitFor();

      // 悬停第二个行（真实环境行）
      await page.locator('.env-row').nth(1).hover();

      const borders = await page.evaluate(() => {
        const row = document.querySelectorAll('.env-row')[1] as HTMLElement;
        const item = row.querySelector('.env-item') as HTMLElement;
        return {
          item: getComputedStyle(item).borderTopColor,
          rowWidth: getComputedStyle(row).borderTopWidth,
        };
      });

      // 全站的 `button:hover` 会给按钮染边框色：自带透明边框占位的按钮必须自己压回透明。
      // （行容器是 div，没有边框时 border-color 会沿用文字色，所以按宽度断言。）
      expect(borders.item, '选项按钮悬停时长出了边框').toBe('rgba(0, 0, 0, 0)');
      expect(borders.rowWidth, '行容器不该有边框').toBe('0px');
    } finally {
      await page.close();
    }
  });

  it('环境行的行高明显大于集合树中的请求行', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('tab', { name: 'Environments' }).click();
      await page.locator('.env-item').first().waitFor();

      const env = await page.evaluate(() => {
        const row = document.querySelector('.env-item') as HTMLElement;
        const check = document.querySelector('.env-check') as HTMLElement | null;
        return {
          height: Math.round(row.getBoundingClientRect().height * 100) / 100,
          checkWidth: check ? check.getBoundingClientRect().width : 0,
        };
      });

      await page.getByRole('tab', { name: 'Collections' }).click();
      await page.locator('[data-testid="workspace-tree"] .node').first().waitFor();
      const tree = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="workspace-tree"] .node') as HTMLElement;
        return Math.round(row.getBoundingClientRect().height * 100) / 100;
      });

      expect(
        env.height,
        `环境行 ${env.height}px，树行 ${tree}px`,
      ).toBeGreaterThan(tree);
      // 勾选标记固定占位，未激活的行也留出同样的宽度
      expect(env.checkWidth).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});

describe('变量表的表面（真实引擎）', () => {
  it('变量表沿用同一套规则：表头吸顶且不透明、单元格静默态无填充无边框', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('tab', { name: 'Environments' }).click();
      await page.getByTestId('environment-editor').waitFor();
      // 行首现在是启用勾选框，静默态要看的是可编辑的值单元格
      await page.locator('.variable-table tbody td input.var-value-input').first().waitFor();

      const style = await page.evaluate(() => {
        const th = document.querySelector('.variable-table thead th') as HTMLElement;
        const input = document.querySelector(
          '.variable-table tbody td input.var-value-input',
        ) as HTMLElement;
        const cell = input.closest('td') as HTMLElement;
        return {
          headerPosition: getComputedStyle(th).position,
          headerBackground: getComputedStyle(th).backgroundColor,
          inputBackground: getComputedStyle(input).backgroundColor,
          inputBorder: getComputedStyle(input).borderTopColor,
          rowHeight: Math.round(cell.getBoundingClientRect().height),
        };
      });

      expect(style.headerPosition).toBe('sticky');
      expect(style.headerBackground).not.toBe('rgba(0, 0, 0, 0)');
      expect(style.inputBackground).toBe('rgba(0, 0, 0, 0)');
      expect(style.inputBorder).toBe('rgba(0, 0, 0, 0)');
      expect(style.rowHeight).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
