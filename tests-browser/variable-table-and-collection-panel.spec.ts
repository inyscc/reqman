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
      case 'environment_list': return [];
      case 'environment_active': return null;
      case 'globals_list': return [];
      // 两条同名变量：靠上那条应当被标注为「被下方同名变量覆盖」
      case 'variable_list': return variables;
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

async function openApp(): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(FAKE_TAURI);
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
