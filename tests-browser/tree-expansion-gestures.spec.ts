// 集合树展开手势在真实引擎里的行为
// （change: rework-tree-expansion-gestures）。
//
// 为什么要真浏览器：
// 1. 「双击不重复切换」靠的是双击第二击带 `MouseEvent.detail === 2`——这个 detail
//    只有真实引擎会自己产生，jsdom 只能手搓，等于自证。
// 2. 「行已获得焦点时，行内的「⋯」菜单仍要能打开」这个坑 jsdom 完全看不见：
//    `fireEvent.click` 不产生 mousedown、也不移动焦点，因此踩不到「mousedown 把焦点
//    移进行内按钮 → 行容器 focusout → 按钮被卸载 → click 落到行容器」这条真实路径。
//    （实现期就是这条把「编辑脚本」入口堵死的。）
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
    var outer = {
      id: 'f-outer', collection_id: 'c1', parent_folder_id: null, name: '外层',
      description: null, auth: auth,
      pre_request_script: null, test_script: null, sort_order: 0
    };
    function request(id, name, url) {
      return {
        id: id, collection_id: 'c1', folder_id: null, name: name,
        method: 'GET', url: url, params: [], headers: [],
        body: { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null },
        auth: auth,
        settings: {
          timeout_ms: null, follow_redirects: true, verify_tls: true,
          http_version: 'auto', encoding: null, proxy: null
        },
        pre_request_script: null, test_script: null, sort_order: 0
      };
    }
    var deep = request('r-deep', '深处的请求', 'https://api.test/deep');
    var outerRequest = request('r-outer', '外层请求', 'https://api.test/outer');

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: collection,
          children: [{
            kind: 'folder', id: 'f-outer', name: '外层', sort_order: 0,
            children: [
              {
                kind: 'folder', id: 'f-inner', name: '内层', sort_order: 0,
                children: [{
                  kind: 'request', id: 'r-deep', name: '深处的请求', sort_order: 0,
                  children: [], request: deep
                }]
              },
              {
                kind: 'request', id: 'r-outer', name: '外层请求', sort_order: 0,
                children: [], request: outerRequest
              }
            ]
          }]
        }];
      case 'environment_list': return [];
      case 'environment_active': return null;
      case 'globals_list': return [];
      case 'variable_list': return [];
      case 'collection_get': return collection;
      case 'folder_get': return outer;
      case 'request_get': return deep;
      case 'settings_get': return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/deep', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], masked: false, insecure_warning: false
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
    // 端口避开 1420（tauri dev）、5197 / 5198 / 5199（其它 browser 用例）
    server: { port: 5196, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5196}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').getByText('深处的请求').waitFor();
  return page;
}

/** 直接读 DOM：Playwright 的定位器自带等待，「即时生效」这类断言要的是快照。 */
async function expandedNow(page: Page, name: string): Promise<boolean> {
  return page.evaluate((target) => {
    const toggles = Array.from(document.querySelectorAll('.tree-toggle'));
    const hit = toggles.find((node) => (node.getAttribute('aria-label') ?? '').endsWith(target));
    return hit?.getAttribute('aria-expanded') === 'true';
  }, name);
}

async function visibleNow(page: Page, label: string): Promise<boolean> {
  return page.evaluate((target) => {
    return Array.from(document.querySelectorAll('.tree-name')).some(
      (node) => node.textContent === target,
    );
  }, label);
}

describe('集合树展开手势（真实引擎）', () => {
  it('单击目录行即时切换展开，且不切主区、不产生标签', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    expect(await visibleNow(page, '深处的请求')).toBe(true);

    await tree.getByText('外层', { exact: true }).click();

    // 单击返回后立刻读：折叠已经生效，没有等任何延时阈值
    expect(await visibleNow(page, '深处的请求')).toBe(false);
    expect(await expandedNow(page, '外层')).toBe(false);
    // 单击目录行是纯视图动作
    expect(await page.getByTestId('entity-script-panel').count()).toBe(0);
    expect(await page.getByTestId('session-tab').count()).toBe(0);
  });

  it('真实双击只切换一次（第二击确实带 detail === 2）', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    // 起点全展开。若第二击未被忽略，双击会切换两次、回到展开态。
    await tree.getByText('外层', { exact: true }).dblclick();
    expect(await expandedNow(page, '外层')).toBe(false);
    expect(await visibleNow(page, '深处的请求')).toBe(false);

    await tree.getByText('外层', { exact: true }).dblclick();
    expect(await expandedNow(page, '外层')).toBe(true);
    expect(await visibleNow(page, '深处的请求')).toBe(true);
  });

  it('展开只作用于被点的那一层，后代的折叠态被保留', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    await tree.getByLabel('折叠 内层').click();
    expect(await visibleNow(page, '深处的请求')).toBe(false);

    await tree.getByText('外层', { exact: true }).click();
    expect(await expandedNow(page, '外层')).toBe(false);

    await tree.getByText('外层', { exact: true }).click();
    expect(await expandedNow(page, '外层')).toBe(true);
    expect(await visibleNow(page, '内层')).toBe(true);
    expect(await visibleNow(page, '外层请求')).toBe(true);
    // 内层仍是折叠的：展开不是递归的
    expect(await visibleNow(page, '深处的请求')).toBe(false);
  });

  it('行已获得焦点时，⋯ 菜单仍能打开并进入脚本面板', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 先点这一行（行容器因此持有焦点），再悬停点「⋯」——真实鼠标下这条路径会先
    // 触发 focusout，行内控件一旦被卸载，click 就落到行容器上，菜单永远打不开。
    await tree.getByText('外层', { exact: true }).click();
    expect(await page.getByTestId('entity-script-panel').count()).toBe(0);

    const row = tree.locator('.node').filter({ hasText: '外层' }).first();
    await row.hover();
    await row.getByLabel('更多操作').click();

    await expect.poll(() => tree.getByRole('menu').count()).toBeGreaterThan(0);
    await tree.getByText('编辑脚本').click();

    await page.getByTestId('entity-script-panel').waitFor();
    expect(await page.getByLabel('文件夹名称').inputValue()).toBe('外层');
  });

  it('单击目录名不选中文字，展开 / 折叠照常发生', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('外层', { exact: true }).click();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(await expandedNow(page, '外层')).toBe(false);
  });

  it('请求行单击仍打开请求；双击名称不选中文字', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 双击请求名：名称文字不被浏览器原生选中（user-select: none），请求照常打开
    await tree.getByText('外层请求', { exact: true }).dblclick();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    await page.getByLabel('请求地址').waitFor();
    expect(await page.getByTestId('session-tab').count()).toBe(1);
  });

  it('键盘 Enter 只作用于行容器自身，不被行内控件带跑', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 折叠箭头：若不拦住行的 keydown，冒泡那一次与按钮按 Enter 补发的 click
    // 会互相抵消，表现为「按了没反应」；拦住后应当就是「切一次」
    await tree.getByLabel('折叠 外层').focus();
    await page.keyboard.press('Enter');
    expect(await expandedNow(page, '外层')).toBe(false);

    await page.keyboard.press('Enter');
    expect(await expandedNow(page, '外层')).toBe(true);

    // 「⋯」：若不拦住，会顺带把这一层折叠掉
    const row = tree.locator('.node').filter({ hasText: '外层' }).first();
    await row.hover();
    await row.getByLabel('更多操作').focus();
    await page.keyboard.press('Enter');
    expect(await expandedNow(page, '外层')).toBe(true);
    await expect.poll(() => tree.getByRole('menu').count()).toBeGreaterThan(0);

    // 菜单项：同上，且应当照常打开脚本面板
    await tree.getByText('编辑脚本').focus();
    await page.keyboard.press('Enter');
    expect(await expandedNow(page, '外层')).toBe(true);
    await page.getByTestId('entity-script-panel').waitFor();
  });

  it('工具栏「全部折叠」一次收起整棵树，随后可逐层展开', async () => {
    const page = await openApp();
    const tree = page.getByTestId('workspace-tree');

    await tree.getByLabel('全部折叠').click();

    expect(await expandedNow(page, '探针集合')).toBe(false);
    expect(await visibleNow(page, '外层')).toBe(false);
    expect(await visibleNow(page, '探针集合')).toBe(true);

    await tree.getByText('探针集合', { exact: true }).click();
    expect(await expandedNow(page, '探针集合')).toBe(true);
    expect(await visibleNow(page, '外层')).toBe(true);
    // 更深一层仍保持折叠
    expect(await visibleNow(page, '外层请求')).toBe(false);
  });
});

describe('请求节点的右键菜单（真实引擎）', () => {
  it('右键打开与「⋯」相同的一份菜单，并阻止运行环境自带的页面菜单', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 记录 contextmenu 的默认行为有没有被拦下：window 是冒泡路径的最后一站，
    // 因此它读到的就是最终状态
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__ctxPrevented = null;
      window.addEventListener('contextmenu', (event) => {
        (window as unknown as Record<string, unknown>).__ctxPrevented = event.defaultPrevented;
      });
    });

    const row = tree.locator('.node').filter({ hasText: '外层请求' }).first();
    await row.click({ button: 'right' });

    await expect.poll(() => tree.getByRole('menu').count()).toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__ctxPrevented,
      ),
    ).toBe(true);

    const fromRightClick = await tree.getByRole('menu').locator('button').allTextContents();
    expect(fromRightClick).toEqual(['重命名', '复制', '删除']);

    // 同一份菜单：换成「⋯」打开，操作项必须完全一致（两处逻辑不分叉）
    await page.keyboard.press('Escape');
    await expect.poll(() => tree.getByRole('menu').count()).toBe(0);
    await row.hover();
    await row.getByLabel('更多操作').click();
    const fromMoreButton = await tree.getByRole('menu').locator('button').allTextContents();
    expect(fromMoreButton).toEqual(fromRightClick);

    // 右键只开菜单，不改变选中：主区没有因此打开任何请求
    expect(await page.getByTestId('session-tab').count()).toBe(0);
  });
});

describe('脚本编辑器的铺满（真实引擎）', () => {
  it('实体脚本面板的编辑器占满右栏，且编辑器下方没有授权说明段落', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    const row = tree.locator('.node').filter({ hasText: '外层' }).first();
    await row.hover();
    await row.getByLabel('更多操作').click();
    await tree.getByText('编辑脚本').click();
    await page.getByTestId('entity-script-panel').waitFor();

    const geometry = await page.evaluate(() => {
      const round = (value: number) => Math.round(value * 100) / 100;
      const area = document.querySelector('[data-testid="entity-script-panel"]') as HTMLElement;
      // 脚本编辑器已是 Monaco 薄壳（change: monaco-code-editors），不再是 textarea
      const editor = area.querySelector('.code-surface') as HTMLElement;
      return {
        areaHeight: round(area.getBoundingClientRect().height),
        editorHeight: round(editor.getBoundingClientRect().height),
      };
    });

    // 编辑器吃掉右栏的绝大部分高度：差的只是左栏提示行与正文内边距
    expect(geometry.editorHeight).toBeGreaterThan(geometry.areaHeight * 0.6);
    // 说明段落已删除
    expect(await page.getByText('视为已授权').count()).toBe(0);
  });
});
