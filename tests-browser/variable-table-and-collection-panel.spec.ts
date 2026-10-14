// 集合面板页签与变量表格在真实引擎里的行为
// （change: rework-collection-tree-and-variable-model）。
//
// 为什么要真浏览器：
// 1. 变量行的拖拽是 HTML5 拖放——jsdom 里只能手搓事件，落点顺序、拖拽期间
//    行是否还留在原位都得靠真引擎作证。
// 2. 「被覆盖」标记是纯视觉提示（⚠ + 悬停文案），真引擎里要同时确认它出现在
//    靠上那一行、且不出现在生效那一行上。
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
    var workspace = { id: 'w1', name: '变量工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '变量集合', auth: auth,
      pre_request_script: null, test_script: null, sort_order: 0
    };
    function variable(id, name, value, order, isSecret) {
      var stored = { state: 'value', value: value };
      return {
        id: id, scope: 'collection', owner_id: 'c1', name: name,
        description: null, is_secret: !!isSecret, enabled: true,
        sort_order: order, initial: stored, current: stored
      };
    }
    function request(id, name) {
      return {
        id: id, collection_id: 'c1', folder_id: null, name: name,
        method: 'GET', url: 'https://api.test/probe', params: [], headers: [],
        body: { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null },
        auth: auth,
        settings: {
          timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
          http_version: 'auto', encoding: null, proxy: null
        },
        pre_request_script: null, test_script: null, sort_order: 0
      };
    }
    // 变量是**有状态**的：界面拖完顺序会再取一次，假后端必须记住新顺序，
    // 否则断言只是撞上乐观重排那一瞬间的中间态。
    var variables = [
      variable('v1', 'token', 'first', 0),
      variable('v2', 'token', 'second', 1),
      // 一条 secret：界面上呈掩码，明文只能经 secret_reveal 取
      variable('v3', 'tokenSecret', '******', 2, true)
    ];

    // 压力模式（openApp 的 stress 选项注入的窗口标记）：把某个作用域的行数拉到
    // 足以溢出一屏——容器内滚动、表头吸顶这些结论都要靠行数撑出来。
    var stress = window.__VARIABLE_SCROLL_STRESS__ || {};
    var environment = {
      id: 'e1', workspace_id: 'w1', name: '滚动环境', is_active: true,
      proxy: null, sort_order: 0
    };
    function manyVariables(scope, ownerId, prefix) {
      var list = [];
      for (var index = 0; index < 40; index += 1) {
        var stored = { state: 'value', value: prefix + '-value-' + index };
        list.push({
          id: prefix + index, scope: scope, owner_id: ownerId, name: prefix + index,
          description: null, is_secret: false, enabled: true, sort_order: index,
          initial: stored, current: stored
        });
      }
      return list;
    }

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: collection,
          children: [
            { kind: 'folder', id: 'f1', name: '子目录', sort_order: 0, children: [] },
            {
              kind: 'request', id: 'r1', name: '探针请求', sort_order: 1,
              children: [], request: request('r1', '探针请求')
            }
          ]
        }];
      case 'environment_list': return stress.environment ? [environment] : [];
      case 'environment_active': return stress.environment ? environment : null;
      case 'globals_list': return [];
      // 两条同名变量：靠上那条应当被标注为「被下方同名变量覆盖」
      case 'variable_list':
        if (args && args.scope === 'collection') {
          return stress.collection ? manyVariables('collection', 'c1', 'many') : variables;
        }
        return stress.environment ? manyVariables('environment', 'e1', 'env') : [];
      case 'secret_reveal':
        return variables.map(function (item) {
          return item.id === 'v3'
            ? Object.assign({}, item, { current: { state: 'value', value: 'REAL_SECRET' } })
            : item;
        })[2];
      case 'variable_reorder':
        var order = (args && args.orderedIds) || [];
        variables = order
          .map(function (id) {
            return variables.filter(function (item) { return item.id === id; })[0];
          })
          .filter(Boolean)
          .map(function (item, index) {
            item.sort_order = index;
            return item;
          });
        return null;
      case 'collection_get': return collection;
      case 'folder_get':
        return {
          id: 'f1', collection_id: 'c1', parent_folder_id: null, name: '子目录',
          description: null, auth: auth,
          pre_request_script: null, test_script: null, sort_order: 0
        };
      case 'request_get': return request('r1', '探针请求');
      case 'settings_get': return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/probe', params: [], headers: [],
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
    // 端口避开 5193~5199（其它 browser 用例）
    server: { port: 5192, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5192}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * 打开应用。
 *
 * `stress` 把某个作用域的行数拉到溢出一屏（见假后端里的同名标记），
 * `viewport` 固定窗口尺寸——「行多时必须滚」「行少时布局不变」这两条
 * 都是几何结论，窗口一变结论就跟着变。
 */
async function openApp(
  options: {
    stress?: { collection?: boolean; environment?: boolean };
    viewport?: { width: number; height: number };
  } = {},
): Promise<Page> {
  const page = await browser.newPage(options.viewport ? { viewport: options.viewport } : {});
  await page.addInitScript(FAKE_TAURI);
  await page.addInitScript(
    (flags) => {
      (window as unknown as Record<string, unknown>).__VARIABLE_SCROLL_STRESS__ = flags;
    },
    {
      collection: options.stress?.collection === true,
      environment: options.stress?.environment === true,
    },
  );
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').getByText('探针请求').waitFor();
  return page;
}

/**
 * 变量表格里各行的值，按界面从上到下——断言拖拽后的顺序要看整条序列。
 * 末位是表格末尾那行幽灵行（新增入口），顺序断言把它一起带上。
 */
async function valuesNow(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.variable-table tbody .var-value-input')).map(
      (node) => (node as HTMLInputElement).value,
    ),
  );
}

/** 每一行：它的值 + 是否带「被覆盖」标记——标记跟着顺序走，不跟着名称走。 */
async function marksNow(page: Page): Promise<{ value: string; marked: boolean }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.variable-table tbody tr')).map((row) => ({
      value: (row.querySelector('.var-value-input') as HTMLInputElement | null)?.value ?? '',
      marked: row.querySelector('[data-testid="overwritten-token"]') !== null,
    })),
  );
}

async function invoked(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>).__invoked as string[]);
}

describe('集合面板的变量 / 脚本页签（真实引擎）', () => {
  it('打开集合面板默认停在变量页签，切到脚本再切回来仍是变量', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('变量集合', { exact: true }).click();

    const variables = page.getByTestId('entity-tab-variables');
    const scripts = page.getByTestId('entity-tab-scripts');
    await variables.waitFor();
    expect(await variables.getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('entity-script-panel').locator('.variable-table').count()).toBe(1);

    await scripts.click();
    expect(await scripts.getAttribute('aria-selected')).toBe('true');
    // 脚本页签里没有变量表
    expect(await page.getByTestId('entity-script-panel').locator('.variable-table').count()).toBe(0);

    await variables.click();
    expect(await variables.getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('entity-script-panel').locator('.variable-table').count()).toBe(1);
  });

  it('文件页面板不出现页签栏（文件夹不承载变量作用域）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('子目录', { exact: true }).click();

    await page.getByTestId('entity-script-panel').waitFor();
    expect(await page.getByTestId('entity-tab-variables').count()).toBe(0);
    expect(await page.getByTestId('entity-tab-scripts').count()).toBe(0);
  });
});

describe('变量表格的重复键与拖拽（真实引擎）', () => {
  it('同名两行共存：靠上那条带「被覆盖」标记，生效那条不带', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('变量集合', { exact: true }).click();
    await page.getByTestId('entity-script-panel').locator('.variable-table').waitFor();

    expect(await page.getByTestId('variable-row-token').count()).toBe(2);
    // 标记只挂在被遮蔽的那一条上，且带可读文案（不只靠颜色）
    expect(await page.getByTestId('overwritten-token').count()).toBe(1);
    expect(await page.getByTestId('overwritten-token').getAttribute('title')).toBe(
      '该变量被下方同名变量覆盖',
    );

    // 悬停提示也能取到文案
    const markedRow = page.getByTestId('variable-row-token').first();
    expect(await markedRow.getByTestId('overwritten-token').count()).toBe(1);
    expect(
      await page.getByTestId('variable-row-token').nth(1).getByTestId('overwritten-token').count(),
    ).toBe(0);
  });

  it('拖动一行改变顺序：靠下的那条变成被覆盖', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('变量集合', { exact: true }).click();
    await page.getByTestId('entity-script-panel').locator('.variable-table').waitFor();

    // 起点：first 在上、second 在下，因此 first 被标记
    //（secret 那条是掩码、没有值输入框，不出现在这个序列里；末位是幽灵行）
    expect(await valuesNow(page)).toEqual(['first', 'second', '']);

    const rows = page.getByTestId('variable-row-token');
    await rows.first().dragTo(rows.nth(1), { targetPosition: { x: 60, y: 15 } });

    await expect.poll(() => valuesNow(page)).toEqual(['second', 'first', '']);
    // 顺序换了，被覆盖的也就换成了现在靠上的 second 那条
    //（第 3 行是 secret，掩码态没有值输入框；末位是幽灵行——都不参与同名分组）
    await expect.poll(() => marksNow(page)).toEqual([
      { value: 'second', marked: true },
      { value: 'first', marked: false },
      { value: '', marked: false },
      { value: '', marked: false },
    ]);
    expect(await invoked(page)).toContain('variable_reorder');
  });

  it('标记与名称之间的距离：集合树与标签行处处相同', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    // 间距一律由容器决定，所以「标记右缘 → 名称左缘」这一段的宽度处处唯一。
    // 树里三种行（集合 / 文件夹 / 请求）与标签里两种前导标记都要量到。
    const measure = () =>
      page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const collect = (scope: string, marker: string, label: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(scope)).flatMap((row) => {
            const lead = row.querySelector<HTMLElement>(marker);
            const name = row.querySelector<HTMLElement>(label);
            if (!lead || !name) return [];
            return [round(name.getBoundingClientRect().left - lead.getBoundingClientRect().right)];
          });
        return {
          tree: collect('.node', '.method-badge, .tree-icon', '.tree-name'),
          tabs: collect('.session-tab', '.method-badge, .tab-kind-icon', '.session-tab-name'),
        };
      });

    // 树里带前导标记的是两种行：文件夹（图标）与请求（方法徽章）。
    // 集合行在树里本来就不带图标，因此不在比较范围内。
    const inTree = (await measure()).tree;
    expect(inTree.length).toBeGreaterThanOrEqual(2);
    expect(new Set(inTree).size).toBe(1);

    // 三种前导标记各开一个标签。顺序有讲究：点集合行会折叠它，所以最后点集合。
    await tree.getByText('探针请求', { exact: true }).click();
    await tree.getByText('子目录', { exact: true }).click();
    await tree.getByText('变量集合', { exact: true }).click();
    expect(await page.getByTestId('session-tab').count()).toBe(3);

    const inTabs = (await measure()).tabs;
    expect(inTabs).toHaveLength(3);
    // 树与标签共用同一个间距值
    expect(new Set([...inTree, ...inTabs]).size).toBe(1);
  });

  it('表格中线可以拖动，key 列宽跟着走', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('变量集合', { exact: true }).click();
    await page.getByTestId('entity-script-panel').locator('.variable-table').waitFor();

    const keyWidth = () =>
      page.evaluate(() =>
        Math.round(
          (document.querySelector('.variable-table thead th') as HTMLElement).getBoundingClientRect()
            .width,
        ),
      );

    // 抓取区必须在单元格内：伸出单元格的那一半会被裁剪，那里的点击落到隔壁
    const contained = await page.evaluate(() => {
      const handle = document.querySelector('.col-resize') as HTMLElement;
      const header = handle.closest('th') as HTMLElement;
      return (
        handle.getBoundingClientRect().right <= header.getBoundingClientRect().right + 0.5
      );
    });
    expect(contained).toBe(true);

    const before = await keyWidth();
    const handle = (await page.getByLabel('调整列宽').boundingBox())!;
    const y = handle.y + handle.height / 2;

    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 80, y, { steps: 5 });
    await page.mouse.up();

    const applied = await page.evaluate(
      () => document.querySelector('.variable-table')?.getAttribute('style') ?? '',
    );
    expect(applied).toContain('--key-width');
    await expect.poll(() => keyWidth()).toBeLessThan(before);
  });

  it('描述留空失焦后不占位，眼睛在两个状态下位置相同', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('变量集合', { exact: true }).click();
    await page.getByTestId('entity-script-panel').locator('.variable-table').waitFor();

    // 点了铅笔、一个字没输就失焦：编辑框收起，且不留下空占位
    await page.getByLabel('描述 tokenSecret').click();
    await page.getByLabel('变量描述 tokenSecret').waitFor();
    await page.getByLabel('变量名 tokenSecret').click();
    await expect.poll(() => page.getByLabel('变量描述 tokenSecret').count()).toBe(0);
    expect(await page.getByTestId('variable-desc-tokenSecret').count()).toBe(0);

    // 眼睛是同一个位置：揭示前后 x 坐标一致，不能因为按钮增减而横向挪动
    const before = (await page.getByLabel('揭示 tokenSecret').boundingBox())!;
    await page.getByLabel('揭示 tokenSecret').click();
    await page.getByLabel('隐藏 tokenSecret').waitFor();
    const after = (await page.getByLabel('隐藏 tokenSecret').boundingBox())!;
    expect(Math.round(after.x)).toBe(Math.round(before.x));
  });

  it('揭示明文不改变行高：值的操作与值同一行', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    const tree = page.getByTestId('workspace-tree');

    await tree.getByText('变量集合', { exact: true }).click();
    await page.getByTestId('entity-script-panel').locator('.variable-table').waitFor();

    // 按行的 testid 找，不按文本：名称活在 input 的 value 里，不进 textContent
    const rowHeight = () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-testid="variable-row-tokenSecret"]');
        return Math.round(row?.getBoundingClientRect().height ?? 0);
      });

    const before = await rowHeight();
    expect(before).toBeGreaterThan(0);

    // 揭示：明文出现，眼睛变成「隐藏」——行高必须一模一样
    await page.getByLabel('揭示 tokenSecret').click();
    await page.getByLabel('变量值 tokenSecret').waitFor();
    expect(await page.getByLabel('变量值 tokenSecret').inputValue()).toBe('REAL_SECRET');
    expect(await rowHeight()).toBe(before);

    // 盖回去：同样不许动高度
    await page.getByLabel('隐藏 tokenSecret').click();
    await expect.poll(() => page.getByLabel('揭示 tokenSecret').count()).toBe(1);
    expect(await rowHeight()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 变量表格的区域滚动（change: rework-variable-table-scroll）
// ---------------------------------------------------------------------------
//
// 为什么要在真引擎里量：这一组结论全是**几何**的——「滚动发生在哪一层」「表头
// 钉没钉在容器顶部」「行多与行少时行宽是否一致」，在 jsdom / happy-dom 里没有
// 布局可言，只能给出假结论。

/** 集合实体面板的正文区（变量页的宿主）。 */
const COLLECTION_HOST = '[data-testid="entity-script-panel"]';
/** 环境编辑器的宿主。 */
const ENVIRONMENT_HOST = '[data-testid="environment-editor"]';
/** 环境编辑器正文区里那层「极端高度才溢出」的兜底滚动容器。 */
const ENVIRONMENT_BODY = `${ENVIRONMENT_HOST} .var-editor`;
/** 行数溢出一屏时的窗口：够高，让「滚动必须发生在容器里」这件事只能由容器承担。 */
const OVERFLOWING_VIEWPORT = { width: 1100, height: 640 };

interface TableScrollGeometry {
  scrollTop: number;
  overflow: number;
  headerTop: number;
  containerTop: number;
  headerPosition: string;
  headerBackground: string;
  gutter: number;
  horizontalOverflow: number;
  /** 宿主范围内有没有悬浮滚动条（环境编辑器那层兜底条也算）。 */
  overlay: boolean;
  /** 变量表容器自己有没有悬浮滚动条——本变更要求它是 false。 */
  tableOverlay: boolean;
  bodyScrollTop: number;
  bodyOverflowY: string;
}

/**
 * 把宿主里的变量表容器滚到底，量它的几何。
 *
 * `body` 是这个宿主的编辑面本身（集合面板的正文区 / 环境编辑器的 `.var-editor`）：
 * 它**不该**被表格带着滚——那正是「滚动不许扩张到整个编辑面」这条要求的判据。
 */
async function scrollTableToEnd(
  page: Page,
  root: string,
  body: string,
): Promise<TableScrollGeometry> {
  await page.locator(`${root} .table-scroll`).first().evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  return page.evaluate(
    ({ root, body }) => {
      const host = document.querySelector(root) as HTMLElement;
      const container = host.querySelector('.table-scroll') as HTMLElement;
      const header = host.querySelector('.variable-table thead th') as HTMLElement;
      const editor = document.querySelector(body) as HTMLElement;
      const round = (value: number) => Math.round(value * 100) / 100;
      return {
        scrollTop: round(container.scrollTop),
        overflow: container.scrollHeight - container.clientHeight,
        headerTop: round(header.getBoundingClientRect().top),
        containerTop: round(container.getBoundingClientRect().top),
        headerPosition: getComputedStyle(header).position,
        headerBackground: getComputedStyle(header).backgroundColor,
        // 占位型滚动条会让 offsetWidth 比 clientWidth 大——行右端那排图标
        // 就会随滚动条的出现而左右跳
        gutter: container.offsetWidth - container.clientWidth,
        horizontalOverflow: container.scrollWidth - container.clientWidth,
        overlay: host.querySelector('[data-testid="overlay-scrollbar"]') !== null,
        // 变量表这一处不绘制任何滚动指示（spec: ui-polish「全局细滚动条」的例外）
        tableOverlay:
          host.querySelector('.table-scroll-wrap [data-testid="overlay-scrollbar"]') !== null,
        bodyScrollTop: round(editor.scrollTop),
        bodyOverflowY: getComputedStyle(editor).overflowY,
      };
    },
    { root, body },
  );
}

/** 表格第一行的行宽与贴右缘控件的位置：行多与行少必须一模一样。 */
async function rowEdges(page: Page, root: string) {
  return page.evaluate((selector) => {
    const host = document.querySelector(selector) as HTMLElement;
    const round = (value: number) => Math.round(value * 100) / 100;
    const table = host.querySelector('.variable-table') as HTMLElement;
    const row = host.querySelector('.variable-table tbody tr') as HTMLElement;
    const keyCell = row.querySelector('td.var-key') as HTMLElement;
    const valueCell = row.querySelector('td.var-value') as HTMLElement;
    const actions = row.querySelector('.var-row-actions') as HTMLElement;
    return {
      tableWidth: round(table.getBoundingClientRect().width),
      keyCellWidth: round(keyCell.getBoundingClientRect().width),
      keyCellRight: round(keyCell.getBoundingClientRect().right),
      valueCellRight: round(valueCell.getBoundingClientRect().right),
      actionsRight: round(actions.getBoundingClientRect().right),
    };
  }, root);
}

/** 打开集合面板的变量页签（行数由 `openApp({ stress })` 决定）。 */
async function openCollectionVariables(page: Page): Promise<void> {
  await page.getByTestId('workspace-tree').getByText('变量集合', { exact: true }).click();
  await page.getByTestId('entity-script-panel').locator('.variable-table').waitFor();
}

/** 打开环境编辑器（行数由 `openApp({ stress })` 决定）。 */
async function openEnvironmentEditor(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Environments' }).click();
  await page.getByTestId('environment-editor').waitFor();
  await page.locator('.var-editor .variable-table').waitFor();
  await page.locator(`${ENVIRONMENT_HOST} [data-testid="environment-proxy"]`).waitFor();
}

describe('变量表格的区域滚动（真实引擎）', () => {
  it('集合变量页行多时在容器内滚动、表头吸顶，面板自身不出现整页滚动', async () => {
    const page = await openApp({
      stress: { collection: true },
      viewport: OVERFLOWING_VIEWPORT,
    });
    page.setDefaultTimeout(10_000);
    try {
      await openCollectionVariables(page);

      const geometry = await scrollTableToEnd(page, COLLECTION_HOST, COLLECTION_HOST);
      expect(geometry.overflow, '表格没有撑到需要滚动，本用例无法验证').toBeGreaterThan(40);
      expect(geometry.scrollTop, '滚动没有发生在表格容器里').toBeGreaterThan(40);
      expect(
        Math.abs(geometry.headerTop - geometry.containerTop),
        `表头没有钉在容器顶部：${JSON.stringify(geometry)}`,
      ).toBeLessThanOrEqual(2);
      expect(geometry.headerPosition).toBe('sticky');
      expect(geometry.headerBackground, '表头表面是透明的，滚过的行会从它下面透出来').not.toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect(geometry.bodyScrollTop, '滚动扩张到了面板正文区').toBe(0);
      // 正文区的 overflow 是给 Body 的 Monaco 补全浮层准备的，本变更不许碰它
      expect(geometry.bodyOverflowY, '正文区的 overflow 被改动了').toBe('clip');
      expect(geometry.gutter, '占位型滚动条吃掉了行宽').toBe(0);
      expect(geometry.horizontalOverflow, '变量表出现了横向滚动').toBeLessThanOrEqual(0);
      // 变量表这一处不绘制任何滚动指示（spec: ui-polish「全局细滚动条」的例外）
      expect(geometry.tableOverlay, '变量表挂上了悬浮滚动条').toBe(false);
      expect(geometry.overlay, '这块界面出现了滚动指示').toBe(false);

      // 表头里的列宽中线跟着表头一起吸顶，且仍完全落在单元格内
      const handle = await page.evaluate((selector) => {
        const host = document.querySelector(selector) as HTMLElement;
        const line = host.querySelector('.col-resize') as HTMLElement;
        const header = line.closest('th') as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        return {
          lineTop: round(line.getBoundingClientRect().top),
          headerTop: round(header.getBoundingClientRect().top),
          lineRight: round(line.getBoundingClientRect().right),
          headerRight: round(header.getBoundingClientRect().right),
        };
      }, COLLECTION_HOST);
      expect(handle.lineRight, '列宽中线伸出了单元格，会被滚动容器裁掉').toBeLessThanOrEqual(
        handle.headerRight + 0.5,
      );
      expect(Math.abs(handle.lineTop - handle.headerTop)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it('集合变量页行少时无任何滚动指示，行宽与贴右缘控件位置与溢出时一致', async () => {
    const few = await openApp({ viewport: OVERFLOWING_VIEWPORT });
    few.setDefaultTimeout(10_000);
    let edgesWhenFew: Awaited<ReturnType<typeof rowEdges>>;
    try {
      await openCollectionVariables(few);
      const geometry = await scrollTableToEnd(few, COLLECTION_HOST, COLLECTION_HOST);
      expect(geometry.overflow, '行数不足一屏却已经需要滚动').toBeLessThanOrEqual(0);
      expect(geometry.overlay, '行数不足一屏却出现了滚动指示').toBe(false);
      expect(geometry.tableOverlay, '行数不足一屏却出现了滚动指示').toBe(false);
      edgesWhenFew = await rowEdges(few, COLLECTION_HOST);
    } finally {
      await few.close();
    }

    const many = await openApp({
      stress: { collection: true },
      viewport: OVERFLOWING_VIEWPORT,
    });
    many.setDefaultTimeout(10_000);
    try {
      await openCollectionVariables(many);
      const geometry = await scrollTableToEnd(many, COLLECTION_HOST, COLLECTION_HOST);
      expect(geometry.overflow).toBeGreaterThan(40);
      // 溢出时同样不出现任何滚动指示，也不占行宽——内容溢出前后行宽与贴右缘
      // 控件的位置必须一模一样（spec: ui-polish「全局细滚动条」的例外场景）
      expect(geometry.tableOverlay, '内容溢出时变量表画了悬浮细条').toBe(false);
      expect(geometry.overlay, '内容溢出时这块界面出现了滚动指示').toBe(false);
      expect(geometry.gutter).toBe(0);
      expect(await rowEdges(many, COLLECTION_HOST)).toEqual(edgesWhenFew);
    } finally {
      await many.close();
    }
  });

  it('环境编辑器里滚动表格时，环境名与代理配置区不随表格滚走', async () => {
    const page = await openApp({
      stress: { environment: true },
      viewport: OVERFLOWING_VIEWPORT,
    });
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironmentEditor(page);

      const before = await page.evaluate((selector) => {
        const host = document.querySelector(selector) as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        const name = host.querySelector('.entity-name') as HTMLElement;
        const proxy = host.querySelector('[data-testid="environment-proxy"]') as HTMLElement;
        const container = host.querySelector('.table-scroll') as HTMLElement;
        const editor = host.querySelector('.var-editor') as HTMLElement;
        return {
          nameTop: round(name.getBoundingClientRect().top),
          proxyBottom: round(proxy.getBoundingClientRect().bottom),
          editorScrollTop: round(editor.scrollTop),
          overflow: container.scrollHeight - container.clientHeight,
        };
      }, ENVIRONMENT_HOST);
      expect(before.overflow, '表格没有撑到需要滚动，本用例无法验证').toBeGreaterThan(40);

      await page.locator(`${ENVIRONMENT_HOST} .table-scroll`).first().evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });

      const after = await page.evaluate((selector) => {
        const host = document.querySelector(selector) as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        const name = host.querySelector('.entity-name') as HTMLElement;
        const proxy = host.querySelector('[data-testid="environment-proxy"]') as HTMLElement;
        const container = host.querySelector('.table-scroll') as HTMLElement;
        const editor = host.querySelector('.var-editor') as HTMLElement;
        const last = host.querySelector('.variable-table tbody tr:last-child') as HTMLElement;
        return {
          nameTop: round(name.getBoundingClientRect().top),
          proxyBottom: round(proxy.getBoundingClientRect().bottom),
          scrollTop: round(container.scrollTop),
          editorScrollTop: round(editor.scrollTop),
          lastRowBottom: round(last.getBoundingClientRect().bottom),
          containerBottom: round(container.getBoundingClientRect().bottom),
        };
      }, ENVIRONMENT_HOST);

      expect(after.scrollTop, '滚动没有发生在表格容器里').toBeGreaterThan(40);
      expect(after.editorScrollTop, '滚动表格把正文区也带着滚了').toBe(before.editorScrollTop);
      expect(after.nameTop, '环境名随表格滚走了').toBe(before.nameTop);
      expect(after.proxyBottom, '代理配置区随表格滚走了').toBe(before.proxyBottom);
      expect(
        after.lastRowBottom,
        '滚到底部时表格的最后一行仍不可见，等于滚不动',
      ).toBeLessThanOrEqual(after.containerBottom + 1);
    } finally {
      await page.close();
    }
  });

  it('环境编辑器里变量表溢出时也不出现任何滚动指示', async () => {
    const page = await openApp({
      stress: { environment: true },
      viewport: OVERFLOWING_VIEWPORT,
    });
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironmentEditor(page);
      const geometry = await scrollTableToEnd(page, ENVIRONMENT_HOST, ENVIRONMENT_BODY);

      expect(geometry.overflow, '表格没有撑到需要滚动，本用例无法验证').toBeGreaterThan(40);
      expect(geometry.gutter, '占位型滚动条吃掉了内容宽度').toBe(0);
      expect(geometry.tableOverlay, '变量表右缘出现了悬浮细条').toBe(false);

      // 悬停在表格上也不该冒出任何指示条：这里既没有悬浮细条，也没有原生占位条
      await page.locator(`${ENVIRONMENT_HOST} .table-scroll`).first().hover();
      await page.waitForTimeout(200);
      const hovered = await page.evaluate((selector) => {
        const host = document.querySelector(selector) as HTMLElement;
        const editor = host.querySelector('.var-editor') as HTMLElement;
        return {
          overlays: host.querySelectorAll('[data-testid="overlay-scrollbar"]').length,
          editorGutter: editor.offsetWidth - editor.clientWidth,
          editorOverflow: editor.scrollHeight - editor.clientHeight,
        };
      }, ENVIRONMENT_HOST);
      expect(hovered.overlays, '悬停表格时冒出了滚动指示').toBe(0);
      expect(hovered.editorGutter, '正文区的原生滚动条占住了宽度').toBe(0);
      // 窗口够高时正文区不溢出——这也说明上面那条「一条指示都没有」不是靠溢出与否碰巧成立的
      expect(
        hovered.editorOverflow,
        '窗口够高时正文区不该溢出（那正是兜底条出现的条件）',
      ).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it('窗口压得很矮时正文区兜底滚动，代理配置区与表格最后一行都可达', async () => {
    const page = await openApp({
      stress: { environment: true },
      viewport: OVERFLOWING_VIEWPORT,
    });
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironmentEditor(page);
      await page.setViewportSize({ width: 1100, height: 260 });

      const short = await page.evaluate((selector) => {
        const host = document.querySelector(selector) as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        const editor = host.querySelector('.var-editor') as HTMLElement;
        const table = host.querySelector('.table-scroll') as HTMLElement;
        const proxy = host.querySelector('[data-testid="environment-proxy"]') as HTMLElement;
        const last = host.querySelector('.variable-table tbody tr:last-child') as HTMLElement;

        const overflow = editor.scrollHeight - editor.clientHeight;
        editor.scrollTop = 0;
        const proxyReachable =
          proxy.getBoundingClientRect().top >= editor.getBoundingClientRect().top - 1;
        // 兜底滚到底：表格区域的底边应当进入视野（表格容器自己还要能继续滚）
        editor.scrollTop = editor.scrollHeight;
        const scrolledByFallback = editor.scrollTop > 0;
        const tableReachable =
          table.getBoundingClientRect().bottom <= editor.getBoundingClientRect().bottom + 1;
        // 表格容器本身照常滚得动：滚到容器底部时最后一行可见
        table.scrollTop = table.scrollHeight;
        const lastRowVisible =
          last.getBoundingClientRect().bottom <= table.getBoundingClientRect().bottom + 1;

        return {
          tableHeight: round(table.getBoundingClientRect().height),
          overflow,
          editorGutter: editor.offsetWidth - editor.clientWidth,
          tableOverlay:
            host.querySelector('.table-scroll-wrap [data-testid="overlay-scrollbar"]') !== null,
          proxyReachable,
          scrolledByFallback,
          tableReachable,
          lastRowVisible,
        };
      }, ENVIRONMENT_HOST);

      // 表格容器保住了最小高度，没有被压成几像素
      expect(short.tableHeight, `表格被压到 ${short.tableHeight}px`).toBeGreaterThanOrEqual(238);
      expect(short.overflow, '窗口压得很矮时正文区没有兜底溢出').toBeGreaterThan(0);
      expect(short.editorGutter, '兜底滚动条占住了宽度').toBe(0);
      expect(short.tableOverlay, '变量表在矮窗口下画了滚动指示').toBe(false);
      expect(short.proxyReachable, '代理配置区被挤出了视野').toBe(true);
      expect(short.scrolledByFallback, '正文区不可滚，下面的内容够不着').toBe(true);
      expect(short.tableReachable, '兜底滚到底也够不着表格区域').toBe(true);
      expect(short.lastRowVisible, '表格容器在矮窗口下滚不动了').toBe(true);
    } finally {
      await page.close();
    }
  });

  it('两种宿主里的表现一致：都在容器内滚动、表头都吸顶、都不绘制滚动指示', async () => {
    const page = await openApp({
      stress: { collection: true, environment: true },
      viewport: OVERFLOWING_VIEWPORT,
    });
    page.setDefaultTimeout(10_000);
    try {
      await openCollectionVariables(page);
      const inCollection = await scrollTableToEnd(page, COLLECTION_HOST, COLLECTION_HOST);

      await openEnvironmentEditor(page);
      const inEnvironment = await scrollTableToEnd(page, ENVIRONMENT_HOST, ENVIRONMENT_BODY);

      const hosts: [string, TableScrollGeometry][] = [
        ['集合实体面板', inCollection],
        ['环境编辑器', inEnvironment],
      ];
      for (const [label, geometry] of hosts) {
        expect(geometry.overflow, `${label}：表格没有撑到需要滚动`).toBeGreaterThan(40);
        expect(geometry.scrollTop, `${label}：滚动没有发生在容器里`).toBeGreaterThan(40);
        expect(
          Math.abs(geometry.headerTop - geometry.containerTop),
          `${label}：表头没有吸顶`,
        ).toBeLessThanOrEqual(2);
        expect(geometry.headerPosition, `${label}：表头不是 sticky`).toBe('sticky');
        expect(geometry.gutter, `${label}：占位型滚动条吃掉了行宽`).toBe(0);
        expect(geometry.tableOverlay, `${label}：变量表右缘出现了滚动指示`).toBe(false);
        expect(geometry.overlay, `${label}：这块界面出现了滚动指示`).toBe(false);
        expect(geometry.bodyScrollTop, `${label}：滚动扩张到了整个编辑面`).toBe(0);
      }
    } finally {
      await page.close();
    }
  });
});
