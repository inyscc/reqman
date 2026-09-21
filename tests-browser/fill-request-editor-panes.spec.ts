// 请求编辑器正文区的满高与区域内滚动在真实引擎里的表现
// （change: fill-request-editor-panes，任务 3.2）。
//
// 为什么要真浏览器：铺满与吸顶都是**几何**结论——flex 链路某一层断掉时
// 「编辑器把正文区顶高而不是铺满」、表头是否钉在滚动容器顶部，这些在
// happy-dom（无真实 layout）里只能给出假结论。
//
// 浏览器从 `./browser` 取（自带 Chromium → 本机 Chrome → 本机 Edge 的退回链），
// 本仓库严禁安装 Playwright 自带的 Chromium。假后端与 session-bar-and-tables
// 的做法一致：应用在没有 Tauri 的环境里起不来，注入最小的 `__TAURI_INTERNALS__`。

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
          timeout_ms: null, follow_redirects: true, verify_tls: true,
          http_version: 'auto', encoding: null, proxy: null
        },
        pre_request_script: null, test_script: null, sort_order: 0
      };
    }
    var nodes = [];
    for (var i = 1; i <= 3; i += 1) {
      nodes.push({
        kind: 'request', id: 'r' + i, name: '请求 ' + i, sort_order: i,
        children: [], request: request(i)
      });
    }

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree': return [{ collection: collection, children: nodes }];
      case 'environment_list': return [];
      case 'environment_active': return null;
      case 'globals_list': return [];
      case 'variable_list': return [];
      case 'collection_get': return collection;
      case 'request_get': return request(1);
      case 'settings_get': return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://api.test/1?a=1', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], used: [], masked: false, insecure_warning: false
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
    // 端口避开 1420（tauri dev）与 5195–5199（其它浏览器用例）
    server: { port: 5194, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5194}`;
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

/** 打开请求 1 并切到 Body 标签，选中指定的请求体类型。 */
async function openBodyTab(page: Page, kind: 'raw' | 'binary'): Promise<Page> {
  await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
  await page.getByLabel('请求地址').waitFor();
  await page.getByRole('button', { name: 'Body', exact: true }).click();
  await page.getByRole('radio', { name: kind }).check();
  return page;
}

describe('raw 正文铺满（真实引擎）', () => {
  it('编辑器占满类型行以下的剩余高度，长正文由编辑器自己滚动', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await openBodyTab(page, 'raw');

      // raw 正文是 Monaco 编辑面：等它渲染出来后点进去输入
      const editor = page.locator('.request-editor .monaco-editor');
      await editor.waitFor({ timeout: 15_000 });
      await editor.click();
      await page.keyboard.insertText(Array.from({ length: 80 }, (_, i) => `{"k${i}": ${i}}`).join('\n'));

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const pane = document.querySelector('.request-editor .pane-body') as HTMLElement;
        const editorNode = document.querySelector('.request-editor .monaco-editor') as HTMLElement;
        const kindRow = document.querySelector('.request-editor .body-kind-row') as HTMLElement;
        const lines = editorNode.querySelector('.lines-content') as HTMLElement | null;
        return {
          paneHeight: round(pane.getBoundingClientRect().height),
          editorHeight: round(editorNode.getBoundingClientRect().height),
          kindRowBottom: round(kindRow.getBoundingClientRect().bottom),
          editorTop: round(editorNode.getBoundingClientRect().top),
          editorBottom: round(editorNode.getBoundingClientRect().bottom),
          paneBottom: round(pane.getBoundingClientRect().bottom),
          // 铺满模式下正文区自身不产生可滚动的溢出（滚动交给编辑器）
          paneOverflow: pane.scrollHeight - pane.clientHeight,
          // 长正文让编辑器内部出现滚动
          editorOverflow: lines ? round(lines.getBoundingClientRect().height) - editorNode.clientHeight : -1,
        };
      });

      // 不再是写死的 220px：编辑器跟着正文区一起长
      expect(geometry.editorHeight, `编辑器高度 ${geometry.editorHeight}px，仍是小固定块`).toBeGreaterThan(240);
      expect(geometry.editorHeight).toBeLessThanOrEqual(geometry.paneHeight);
      // 编辑器紧贴在类型行之下、正文区内边距之上，下方不残留大块空白
      expect(geometry.editorTop).toBeGreaterThanOrEqual(geometry.kindRowBottom - 1);
      expect(geometry.paneBottom - geometry.editorBottom, '编辑器下方残留大块空白').toBeLessThanOrEqual(12);
      expect(geometry.paneOverflow, '正文区自身出现了滚动溢出').toBeLessThanOrEqual(1);
      expect(geometry.editorOverflow, '长正文没有让编辑器内部滚动').toBeGreaterThan(40);
    } finally {
      await page.close();
    }
  });
});

describe('键值表满高容器（真实引擎）', () => {
  it('行多时在表格容器内滚动，正文区自身不滚', async () => {
    const page = await openApp({ width: 1000, height: 420 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      // Params 是默认标签；把表格撑到必须滚动
      for (let index = 0; index < 16; index += 1) {
        const ghost = page.getByLabel('新增行的名称');
        await ghost.click();
        await page.keyboard.type(`k${index}`);
        await page.keyboard.press('Enter');
      }

      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('.request-editor .pane-body') as HTMLElement;
        const table = document.querySelector('.request-editor .table-scroll') as HTMLElement;
        return {
          tableOverflow: table.scrollHeight - table.clientHeight,
          paneOverflow: pane.scrollHeight - pane.clientHeight,
          tableScrollable: getComputedStyle(table).overflowY === 'auto' || getComputedStyle(table).overflow === 'auto',
          // 占位型滚动条会让 offsetWidth 比 clientWidth 大——行右端的删除按钮
          // 就会随滚动条的出现而左右跳
          gutter: table.offsetWidth - table.clientWidth,
          overlay: document.querySelector('[data-testid="overlay-scrollbar"]') !== null,
        };
      });

      expect(geometry.tableOverflow, '表格没有撑到需要滚动').toBeGreaterThan(40);
      expect(geometry.tableScrollable, '表格容器不可滚动').toBe(true);
      expect(geometry.paneOverflow, '滚动溢出扩张到了正文区').toBeLessThanOrEqual(1);
      expect(geometry.gutter, '滚动条占了表格的行宽').toBe(0);
      expect(geometry.overlay, '没有绘制悬浮滚动条').toBe(true);

      // 滚动发生在表格容器内部
      const scrolled = await page.evaluate(() => {
        const table = document.querySelector('.request-editor .table-scroll') as HTMLElement;
        const pane = document.querySelector('.request-editor .pane-body') as HTMLElement;
        table.scrollTop = 150;
        return { table: table.scrollTop, pane: pane.scrollTop };
      });
      expect(scrolled.table, '表格容器滚动没有生效').toBeGreaterThan(40);
      expect(scrolled.pane, '正文区被表格带着滚了').toBeLessThanOrEqual(0);
    } finally {
      await page.close();
    }
  });

  it('行数不足一屏时容器无滚动条，且占满正文区剩余高度', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const pane = document.querySelector('.request-editor .pane-body') as HTMLElement;
        const table = document.querySelector('.request-editor .table-scroll') as HTMLElement;
        const paneStyle = getComputedStyle(pane);
        return {
          overflow: table.scrollHeight - table.clientHeight,
          tableHeight: round(table.getBoundingClientRect().height),
          // 正文区上下各有一圈 --space-4 内边距
          expectedHeight: round(
            pane.clientHeight - parseFloat(paneStyle.paddingTop) - parseFloat(paneStyle.paddingBottom),
          ),
        };
      });

      expect(geometry.overflow, '行数不足一屏却出现了滚动').toBeLessThanOrEqual(0);
      expect(
        Math.abs(geometry.tableHeight - geometry.expectedHeight),
        `表格容器没有占满剩余高度：实际 ${geometry.tableHeight}px，期望 ${geometry.expectedHeight}px`,
      ).toBeLessThanOrEqual(2);
    } finally {
      await page.close();
    }
  });

  it('表格容器内滚动时表头吸顶且表面不透明', async () => {
    const page = await openApp({ width: 1000, height: 420 });
    try {
      await page.getByRole('button', { name: 'GET 请求 1', exact: true }).click();
      await page.getByLabel('请求地址').waitFor();

      for (let index = 0; index < 16; index += 1) {
        const ghost = page.getByLabel('新增行的名称');
        await ghost.click();
        await page.keyboard.type(`k${index}`);
        await page.keyboard.press('Enter');
      }

      const table = page.locator('.request-editor .table-scroll').first();
      await table.evaluate((node) => {
        node.scrollTop = 200;
      });

      const geometry = await page.evaluate(() => {
        const container = document.querySelector('.request-editor .table-scroll') as HTMLElement;
        const header = document.querySelector('.request-editor thead th') as HTMLElement;
        const round = (value: number) => Math.round(value * 100) / 100;
        return {
          containerTop: round(container.getBoundingClientRect().top),
          headerTop: round(header.getBoundingClientRect().top),
          scrollTop: round(container.scrollTop),
          headerPosition: getComputedStyle(header).position,
          headerBackground: getComputedStyle(header).backgroundColor,
        };
      });

      expect(geometry.scrollTop, '滚动没有生效').toBeGreaterThan(40);
      expect(
        Math.abs(geometry.headerTop - geometry.containerTop),
        `表头没有钉在表格容器顶部：${JSON.stringify(geometry)}`,
      ).toBeLessThanOrEqual(2);
      expect(geometry.headerPosition).toBe('sticky');
      expect(geometry.headerBackground, '表头表面是透明的，滚过的行会从它下面透出来').not.toBe(
        'rgba(0, 0, 0, 0)',
      );
    } finally {
      await page.close();
    }
  });
});

describe('binary 保持一行（真实引擎）', () => {
  it('只有一行选取入口，落在正文区顶部，无滚动无多余空白', async () => {
    const page = await openApp({ width: 1100, height: 700 });
    try {
      await openBodyTab(page, 'binary');
      // binary 已升级为带选取入口的一行（change: form-data-postman-layout）
      await page.getByRole('button', { name: '选择二进制文件' }).waitFor();

      const geometry = await page.evaluate(() => {
        const round = (value: number) => Math.round(value * 100) / 100;
        const pane = document.querySelector('.request-editor .pane-body') as HTMLElement;
        const row = pane.querySelector('.row') as HTMLElement;
        const kindRow = pane.querySelector('.body-kind-row') as HTMLElement;
        return {
          rowCount: pane.querySelectorAll('.row').length,
          rowHeight: round(row.getBoundingClientRect().height),
          kindRowBottom: round(kindRow.getBoundingClientRect().bottom),
          rowTop: round(row.getBoundingClientRect().top),
          overflow: pane.scrollHeight - pane.clientHeight,
          editorCount: pane.querySelectorAll('.monaco-editor').length,
          tableCount: pane.querySelectorAll('.table-scroll').length,
        };
      });

      expect(geometry.rowCount, 'binary 只有一行选取入口').toBe(1);
      expect(geometry.editorCount).toBe(0);
      expect(geometry.tableCount).toBe(0);
      expect(geometry.rowHeight, 'binary 的这一行远不止一行高').toBeLessThan(60);
      expect(geometry.rowTop).toBeGreaterThanOrEqual(geometry.kindRowBottom - 1);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });
});
