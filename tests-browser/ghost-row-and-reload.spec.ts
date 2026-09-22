// 幽灵行与「重载前的未保存处置」在真实引擎里的行为
// （change: reduce-explicit-save-and-add-controls，任务 2.5 与 5.3）。
//
// 为什么要真浏览器：幽灵行的关键性质是「正在输入的那个 DOM 元素不被重挂」与
// 「Tab 能落到末行空行」——这两条 jsdom/happy-dom 给不出可信结论（它们不做布局，
// 也不会因为 DOM 移动而失焦）。组合输入（中文输入法）更是只在真引擎里才成立。
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

/** 假后端：文档创建后、应用脚本之前装好（与 Tauri 的注入时机一致）。 */
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
    var workspace = { id: 'w1', name: '探针工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '探针集合',
      auth: { kind: 'inherit', basic: null, bearer: null, api_key: null },
      pre_request_script: null, test_script: null, sort_order: 0
    };
    var request = {
      id: 'r1', collection_id: 'c1', folder_id: null, name: '探针请求',
      method: 'GET', url: 'https://api.test/users',
      params: [{ key: 'a', value: '1', enabled: true }],
      headers: [],
      body: { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null },
      auth: { kind: 'inherit', basic: null, bearer: null, api_key: null },
      settings: {
        timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
        http_version: 'auto', encoding: null, proxy: null
      },
      pre_request_script: null, test_script: null, sort_order: 0
    };

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: collection,
          children: [{
            kind: 'request', id: 'r1', name: '探针请求', sort_order: 0,
            children: [], request: request
          }]
        }];
      case 'environment_list': return [];
      case 'environment_active': return null;
      case 'globals_list': return [];
      case 'variable_list': return [];
      case 'collection_get': return collection;
      case 'request_get': return request;
      case 'settings_get': return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/users', params: [], headers: [],
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
    // 端口避开 1420（tauri dev）、5197（host-injection）、5199（script-runtime）
    server: { port: 5198, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5198}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** 打开应用并选中那条探针请求。 */
async function openRequest(browserInstance: Browser): Promise<Page> {
  const page = await browserInstance.newPage();
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });

  await page.getByTestId('workspace-tree').getByText('探针请求').click();
  await page.getByLabel('请求地址').waitFor();

  return page;
}

/** 表格每一行的高度。 */
async function rowHeights(page: Page): Promise<number[]> {
  return page.$$eval('.request-editor tbody tr', (rows) =>
    rows.map((row) => row.getBoundingClientRect().height),
  );
}

describe('幽灵行（真实引擎）', () => {
  it('Tab 从最后一行内容落到末行空行，且两者行高一致', async () => {
    const page = await openRequest(browser);
    try {
      // Params 里有一条既有参数，因此表格是「1 个内容行 + 1 个幽灵行」
      const heights = await rowHeights(page);
      expect(heights).toHaveLength(2);

      const layout = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.request-editor tbody tr')).map((row) => {
          const textInput = row.querySelector('input:not([type="checkbox"])');
          const button = row.querySelector('button');
          const round = (value: number) => Math.round(value * 100) / 100;
          return {
            ghost: row.classList.contains('ghost-row'),
            height: round(row.getBoundingClientRect().height),
            cells: Array.from(row.querySelectorAll('td')).map((cell) =>
              round(cell.getBoundingClientRect().height),
            ),
            input: textInput ? round(textInput.getBoundingClientRect().height) : null,
            button: button ? round(button.getBoundingClientRect().height) : null,
          };
        }),
      );
      expect(
        Math.abs(heights[0] - heights[1]),
        `行高不一致：${JSON.stringify(layout)}`,
      ).toBeLessThanOrEqual(1);

      // 从最后一行内容里的删除按钮按一次 Tab，应当直接落到幽灵行的名称输入
      await page.locator('.request-editor tbody tr').first().getByLabel('删除该行').focus();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        '新增行的名称',
      );
    } finally {
      await page.close();
    }
  });

  it('逐字符连续输入只生成一行，正被输入的元素不被重挂', async () => {
    const page = await openRequest(browser);
    try {
      const ghostKey = page.getByLabel('新增行的名称');
      await ghostKey.click();
      await page.keyboard.type('X-Trace-Id', { delay: 10 });

      // 输入过程中：被输入的那一行由幽灵行自己承载（不重复渲染），表格是
      // 「1 个普通行 + 正在编辑的幽灵行 + 它下方的占位行」，行数不再增长，
      // 焦点也还在同一个元素上
      expect(await rowHeights(page)).toHaveLength(3);
      expect(await ghostKey.inputValue()).toBe('X-Trace-Id');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
        '新增行的名称',
      );

      // 结束这一行：内容落成普通行，下方补出新的空行
      await page.keyboard.press('Enter');
      expect(await rowHeights(page)).toHaveLength(3);
      expect(await page.getByLabel('参数名 1', { exact: true }).inputValue()).toBe('X-Trace-Id');
      expect(await ghostKey.inputValue()).toBe('');
      // 原有的那一行没被带跑
      expect(await page.getByLabel('参数名 0', { exact: true }).inputValue()).toBe('a');
    } finally {
      await page.close();
    }
  });

  it('中文组合输入期间不会一行变多行', async () => {
    const page = await openRequest(browser);
    try {
      const cdp = await page.context().newCDPSession(page);
      const ghostKey = page.getByLabel('新增行的名称');
      await ghostKey.click();

      // 真组合过程：先上报候选串，再落字
      await cdp.send('Input.imeSetComposition', {
        text: '你好',
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send('Input.insertText', { text: '你好' });

      // 组合过程中的中间态没有被物化成额外的行（行数与键入后一致：内容行 +
      // 正在编辑的幽灵行 + 它下方的占位行）
      expect(await rowHeights(page)).toHaveLength(3);
      expect(await ghostKey.inputValue()).toBe('你好');

      await page.keyboard.press('Enter');
      expect(await rowHeights(page)).toHaveLength(3);
      expect(await page.getByLabel('参数名 1', { exact: true }).inputValue()).toBe('你好');
    } finally {
      await page.close();
    }
  });
});

describe('重载前的未保存处置（真实引擎）', () => {
  it('有未保存改动时，重载会弹出确认并因此被取消', async () => {
    const page = await openRequest(browser);
    try {
      await page.getByLabel('请求地址').fill('https://api.test/edited');
      await page.getByText('未保存').waitFor();

      let dialogType: string | null = null;
      page.on('dialog', async (dialog) => {
        dialogType = dialog.type();
        // 关掉对话框 = 用户选「留在此页」，这次重载应当被取消
        await dialog.dismiss();
      });

      let reloadCancelled = false;
      try {
        await page.reload({ timeout: 4000 });
      } catch {
        reloadCancelled = true;
      }

      expect(dialogType).toBe('beforeunload');
      expect(reloadCancelled).toBe(true);
      // 页面没被换掉：编辑中的内容还在
      expect(await page.getByLabel('请求地址').inputValue()).toBe('https://api.test/edited');
    } finally {
      await page.close();
    }
  });

  it('没有未保存改动时不打断重载', async () => {
    const page = await openRequest(browser);
    try {
      // 放一个只存在于本次文档的标记：重载后它应当消失
      await page.evaluate(() => {
        (window as unknown as { __bootMarker?: boolean }).__bootMarker = true;
      });

      let dialogSeen = false;
      page.on('dialog', async (dialog) => {
        dialogSeen = true;
        await dialog.dismiss();
      });

      await page.reload({ waitUntil: 'load' });

      expect(dialogSeen).toBe(false);
      expect(
        await page.evaluate(() => (window as unknown as { __bootMarker?: boolean }).__bootMarker),
      ).toBeUndefined();
    } finally {
      await page.close();
    }
  });
});
