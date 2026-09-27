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
  invoke: async function (cmd, args) {
    window.__invoked = (window.__invoked || []).concat([cmd]);
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
          timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
          http_version: 'auto', encoding: null, proxy: null
        },
        pre_request_script: null, test_script: null, sort_order: 0
      };
    }
    var deep = request('r-deep', '深处的请求', 'https://api.test/deep');
    var outerRequest = request('r-outer', '外层请求', 'https://api.test/outer');
    // 改名后的名字挂在 window 上：invoke 每次调用都会重建局部变量，
    // 要跨调用记住改名结果只能放这里
    window.__folderName = window.__folderName || '外层';
    window.__collectionName = window.__collectionName || '探针集合';

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: Object.assign({}, collection, { name: window.__collectionName }),
          children: [{
            kind: 'folder', id: 'f-outer', name: window.__folderName, sort_order: 0,
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
      // 树上的就地改名：把新名字记下来，界面因此能真的看到改名结果
      case 'folder_rename':
        window.__folderName = (args && args.name) || window.__folderName;
        return Object.assign({}, outer, { name: window.__folderName });
      case 'collection_rename':
        window.__collectionName = (args && args.name) || window.__collectionName;
        return Object.assign({}, collection, { name: window.__collectionName });
      case 'folder_get': return Object.assign({}, outer, { name: window.__folderName });
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

/** 树里各行的名称，按界面从上到下的顺序——断言排序要看整条序列。 */
async function orderNow(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.tree-name')).map((node) => node.textContent ?? ''),
  );
}

/** 应用到目前为止调用过的后端命令；拖拽是否真的落库要靠它作证。 */
async function invoked(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>).__invoked as string[]);
}

/**
 * 集合树的手势与行内控件。
 *
 * 注意「⋯」菜单（`.node-menu`）是**覆盖层**：它 portal 到 `document.body`、按触发器的
 * 实测矩形自定位——留在行内会被树的滚动容器裁掉，最底部的节点因此点不出菜单。所以菜单
 * 与它的选项要用 `page.getBy…` 查，不能挂在 `tree` 作用域下（`tree` 只覆盖树本身）。
 * 行内就地的重命名输入框仍在树里，照旧用 `tree.getByLabel(...)`。
 */
describe('集合树展开手势（真实引擎）', () => {
  it('单击目录行即时切换展开，并打开该实体的面板（新增一个标签）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    expect(await visibleNow(page, '深处的请求')).toBe(true);

    await tree.getByText('外层', { exact: true }).click();

    // 单击返回后立刻读：折叠已经生效，没有等任何延时阈值
    expect(await visibleNow(page, '深处的请求')).toBe(false);
    expect(await expandedNow(page, '外层')).toBe(false);
    // 单击目录行同时打开这个实体：主区进脚本面板，标签栏多一个
    await page.getByTestId('entity-script-panel').waitFor();
    expect(await page.getByTestId('session-tab').count()).toBe(1);
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

  it('贴近底边的行，菜单向上展开且完整可见（spec: 浮层在垂直方向的定位）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);

    // 压矮视口并把树滚到底：最后一行贴近**视口**下沿，下方放不下整个菜单。
    // 方向判定看的是视口（菜单是覆盖层，不再受容器裁剪），所以这里要的是真正贴底
    await page.setViewportSize({ width: 900, height: 240 });
    await page.evaluate(() => {
      const scroller = document.querySelector('.tree-root') as HTMLElement | null;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });

    const last = page.locator('.tree-root .node').last();
    await last.hover();
    await last.getByLabel('更多操作').click();
    await expect.poll(() => page.getByRole('menu').count()).toBeGreaterThan(0);

    const geometry = await page.evaluate(() => {
      const menu = document.querySelector('.node-menu') as HTMLElement | null;
      // 「⋯」只在悬停或菜单打开的那一行渲染，因此此刻页面上只有一个
      const trigger = document.querySelector('.node-more') as HTMLElement | null;
      if (!menu || !trigger) return null;

      const menuRect = menu.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();

      return {
        menuTop: menuRect.top,
        menuBottom: menuRect.bottom,
        triggerTop: triggerRect.top,
        viewportHeight: window.innerHeight,
      };
    });

    expect(geometry, '菜单或触发器没有量到').not.toBeNull();
    // 下方放不下 → 翻到上方：菜单整体落在触发行之上，且不越出视口
    expect(geometry!.menuBottom).toBeLessThanOrEqual(geometry!.triggerTop + 1);
    expect(geometry!.menuTop).toBeGreaterThanOrEqual(0);
    expect(geometry!.menuBottom).toBeLessThanOrEqual(geometry!.viewportHeight);
  });

  it('行已获得焦点时，⋯ 菜单仍能打开并进入脚本面板', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 先点这一行（行容器因此持有焦点，面板也随即打开），再悬停点「⋯」——真实鼠标
    // 下这条路径会先触发 focusout，行内控件一旦被卸载，click 就落到行容器上，
    // 菜单永远打不开。
    await tree.getByText('外层', { exact: true }).click();
    await page.getByTestId('entity-script-panel').waitFor();

    const row = tree.locator('.node').filter({ hasText: '外层' }).first();
    await row.hover();
    await row.getByLabel('更多操作').click();

    await expect.poll(() => page.getByRole('menu').count()).toBeGreaterThan(0);
    await page.getByText('编辑脚本').click();

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
    await expect.poll(() => page.getByRole('menu').count()).toBeGreaterThan(0);

    // 菜单项：同上，且应当照常打开脚本面板。
    // 按 role 取而不是按文本：项里还并列着键位，文本节点不再整块等于项名
    await page.getByRole('menuitem', { name: /编辑脚本/ }).focus();
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

    await expect.poll(() => page.getByRole('menu').count()).toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__ctxPrevented,
      ),
    ).toBe(true);

    const fromRightClick = await page
      .getByRole('menu')
      .locator('button .node-menu-label')
      .allTextContents();
    expect(fromRightClick).toEqual(['重命名', '复制', '删除']);

    // 操作项右侧并列显示键位（spec: 树操作的快捷键）
    const shortcuts = await page
      .getByRole('menu')
      .locator('.node-menu-shortcut')
      .allTextContents();
    expect(shortcuts).toEqual(['Ctrl+E', 'Ctrl+D']);

    // 同一份菜单：换成「⋯」打开，操作项必须完全一致（两处逻辑不分叉）
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('menu').count()).toBe(0);
    await row.hover();
    await row.getByLabel('更多操作').click();
    const fromMoreButton = await page
      .getByRole('menu')
      .locator('button .node-menu-label')
      .allTextContents();
    expect(fromMoreButton).toEqual(fromRightClick);

    // 右键只开菜单，不改变选中：主区没有因此打开任何请求
    expect(await page.getByTestId('session-tab').count()).toBe(0);
  });
});

/** 某个节点嵌在第几层（数它上面有多少个 `ul.tree`）——移动是否真的改变归属靠它。 */
async function depthNow(page: Page, label: string): Promise<number> {
  return page.evaluate((target) => {
    const row = Array.from(document.querySelectorAll('.tree-name')).find(
      (node) => node.textContent === target,
    );
    if (!row) return -1;
    let depth = 0;
    let node = row.parentElement;
    while (node) {
      if (node.tagName === 'UL' && node.classList.contains('tree')) depth += 1;
      node = node.parentElement;
    }
    return depth;
  }, label);
}

describe('集合树拖拽（真实引擎）', () => {
  it('同级拖拽改变顺序，并写入一次重排', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 起点：外层下依次是「内层（含深处的请求）」「外层请求」
    expect(await orderNow(page)).toEqual([
      '探针集合',
      '外层',
      '内层',
      '深处的请求',
      '外层请求',
    ]);

    const inner = tree.locator('.node').filter({ hasText: '内层' }).first();
    const outerRequest = tree.locator('.node').filter({ hasText: '外层请求' }).first();
    // 落在请求行的下半区：请求行没有「移入」语义，只会被理解为同级排序
    await inner.dragTo(outerRequest, { targetPosition: { x: 60, y: 15 } });

    await expect.poll(() => orderNow(page)).toEqual([
      '探针集合',
      '外层',
      '外层请求',
      '内层',
      '深处的请求',
    ]);
    expect(await invoked(page)).toContain('children_reorder');
  });

  it('拖到目录行的中间区域是「移入」：层级变深一次', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 起点：根 → 集合的子级 → 外层的子级，共三层
    expect(await depthNow(page, '外层请求')).toBe(3);

    const inner = tree.locator('.node').filter({ hasText: '内层' }).first();
    const outerRequest = tree.locator('.node').filter({ hasText: '外层请求' }).first();
    await outerRequest.dragTo(inner, { targetPosition: { x: 60, y: 11 } });

    await expect.poll(() => depthNow(page, '外层请求')).toBe(4);
    expect(await invoked(page)).toContain('request_move');
  });

  it('跨目录按落点插入：插到指示的位置，而不是目标目录的末尾', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 起点：「内层」（挂在「外层」下）里挂着「深处的请求」
    expect(await orderNow(page)).toEqual([
      '探针集合',
      '外层',
      '内层',
      '深处的请求',
      '外层请求',
    ]);

    // 把「深处的请求」拖到「内层」行的**上半区**：目标父级变成「外层」、位置是第 0 位。
    // 这条用例的全部价值在于它能区分两种实现：按落点插入得 [深处的请求, 内层, 外层请求]，
    // 而"忽略位置、一律追加到目标父级末尾"得 [内层, 外层请求, 深处的请求]——两者不同。
    const inner = tree.locator('.node').filter({ hasText: '内层' }).first();
    const deepRequest = tree.locator('.node').filter({ hasText: '深处的请求' }).first();
    await deepRequest.dragTo(inner, { targetPosition: { x: 60, y: 4 } });

    await expect.poll(() => orderNow(page)).toEqual([
      '探针集合',
      '外层',
      '深处的请求',
      '内层',
      '外层请求',
    ]);
    expect(await invoked(page)).toContain('request_move');
  });

  it('搜索态下不可拖拽：行不可拖，顺序也不变', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByLabel('搜索请求').fill('请求');
    const draggable = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.tree-name')).find(
        (node) => node.textContent === '外层请求',
      );
      return row?.closest('.node')?.getAttribute('draggable');
    });
    expect(draggable).toBe('false');

    const before = await orderNow(page);
    const inner = tree.locator('.node').filter({ hasText: '内层' }).first();
    const outerRequest = tree.locator('.node').filter({ hasText: '外层请求' }).first();
    await outerRequest.dragTo(inner, { targetPosition: { x: 60, y: 15 } });

    expect(await orderNow(page)).toEqual(before);
    expect(await invoked(page)).not.toContain('children_reorder');
    expect(await invoked(page)).not.toContain('request_move');
  });
});

describe('树上就地改名（真实引擎）', () => {
  it('输入框占住名字的位置：行高不变，回车落库、Esc 退出', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    const heightOf = () =>
      page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('.node')).find((node) =>
          node.textContent?.includes('外层'),
        ) as HTMLElement;
        return Math.round(row.getBoundingClientRect().height);
      });

    const row = tree.locator('.node').filter({ hasText: '外层' }).first();
    await row.hover();
    const before = await heightOf();

    await row.getByLabel('更多操作').click();
    await page.getByText('重命名').click();

    const input = tree.getByLabel('重命名 外层');
    await input.waitFor();
    // 就地编辑不改变行的几何：输入框接替了名字占的那一格
    expect(await heightOf()).toBe(before);

    // 编辑态不亮出操作入口：它白占名称区域（按输入框反查所在行——
    // 编辑态下这一行的文本已经是输入框的 value，按文本找会落到相邻行上）
    const editingRow = tree.locator('.node').filter({ has: page.locator('.node-rename') });
    await expect.poll(() => editingRow.locator('.node-more').count()).toBe(0);

    // 输入框独占名称区域：它与右侧操作入口之间只隔行内那段 gap，
    // 中间不再夹着被占位吸收的空白——改前那段空白会吃掉一半剩余宽度。
    const nameArea = await page.evaluate(() => {
      const round = (value: number) => Math.round(value);
      // 从输入框反查它所在的行：编辑态下这一行的文本已变成输入框的 value，
      // 按 textContent 找会落到相邻的"外层请求"那一行上
      const input = document.querySelector('.node-rename') as HTMLElement;
      const row = input.closest('.node') as HTMLElement;
      const more = row.querySelector('.node-more') as HTMLElement | null;
      const edge = more ? more.getBoundingClientRect().left : row.getBoundingClientRect().right;
      return {
        input: round(input.getBoundingClientRect().width),
        row: round(row.getBoundingClientRect().width),
        toEdge: round(edge - input.getBoundingClientRect().right),
      };
    });
    // 名字只有两个字；半行宽时不可能超过行宽的一半这么多
    expect(nameArea.input).toBeGreaterThan(nameArea.row * 0.5);
    expect(nameArea.toEdge).toBeLessThan(24);

    // Esc：退出编辑，不落库
    await input.press('Escape');
    await expect.poll(() => tree.getByLabel('重命名 外层').count()).toBe(0);
    expect(await invoked(page)).not.toContain('folder_rename');

    // 再进一次，改名并回车：命令落到后端，树上显示新名字
    await row.hover();
    await row.getByLabel('更多操作').click();
    await page.getByText('重命名').click();
    const editing = tree.getByLabel('重命名 外层');
    await editing.fill('改名后的外层');
    await editing.press('Enter');

    await expect.poll(() => invoked(page)).toContain('folder_rename');
    await expect.poll(() => tree.getByText('改名后的外层').count()).toBe(1);
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
    await page.getByText('编辑脚本').click();
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
