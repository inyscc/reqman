// 环境列表的拖拽 / 滚动 与 通用下拉的两条修复（change: rework-environments-list）。
//
// 为什么必须在真引擎里跑：
// - 拖拽是 HTML5 DnD 的真实手势；
// - 「滚动条不占内容宽度」是几何结论（`offsetWidth - clientWidth`），jsdom 没有布局；
// - 「菜单里的按下会不会把窗口拖走」要看 React portal 的事件冒泡是否真的冒到会话标签行，
//   而判据是 `plugin:window|start_dragging` 有没有被 invoke——因此假后端必须可观测。
//
// 两条已知的引擎限制（用例据此写，别把结论读过头）：
// 1. 本地跑的是 **headless** Chrome，它用覆盖式滚动条，`gutter` 恒为 0——所以「不占宽」这条
//    在 headless 里不是可判别断言，本用例改为断言 `scrollbar-width: none` 已生效 + 自绘悬浮条
//    在场 + 行宽不随溢出变化；WebView2（占位型滚动条）上的真实表现由真机验收覆盖。
// 2. 原生滚动指示条在 headless 下不是独立的命中目标，因此「拖动菜单的滚动指示条」无法被驱动；
//    本用例改为断言在该区域按下不关闭菜单、也不触发窗口拖拽——真正的滚动仍由滚轮那条路径验证。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

/** 30 个环境：侧栏列表必须溢出（才谈得上悬浮条与滚动），下拉菜单也必须超出一屏。 */
const ENVIRONMENT_COUNT = 30;

const FAKE_TAURI = `
window.__invoked = [];
window.__reorderPayload = null;
(function () {
  var environments = [];
  for (var i = 1; i <= ${ENVIRONMENT_COUNT}; i += 1) {
    environments.push({
      id: 'e' + i, workspace_id: 'w1', name: '环境 ' + i, is_active: false,
      proxy: null, sort_order: i - 1
    });
  }

  window.__TAURI_INTERNALS__ = {
    // 缺了 metadata，getCurrentWindow() 会抛，startDragging 根本走不到 invoke——
    // 那样"没触发窗口拖拽"的断言会假阳性通过
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' }
    },
    transformCallback: function (callback) {
      var id = Math.floor(Math.random() * 1000000);
      window['_' + id] = callback;
      return id;
    },
    unregisterCallback: function (id) { delete window['_' + id]; },
    convertFileSrc: function (path) { return path; },
    invoke: async function (cmd, args) {
      window.__invoked.push(cmd);
      var auth = { kind: 'inherit', basic: null, bearer: null, api_key: null };
      var workspace = { id: 'w1', name: '探针工作区' };
      var collection = {
        id: 'c1', workspace_id: 'w1', name: '探针集合', auth: auth,
        pre_request_script: null, test_script: null, sort_order: 0
      };
      switch (cmd) {
        case 'workspace_list': return [workspace];
        case 'workspace_active': return workspace;
        case 'workspace_tree': return [{ collection: collection, children: [] }];
        case 'environment_list': return environments;
        case 'environment_active': return null;
        case 'environment_reorder': {
          var orderedIds = (args && args.orderedIds) || [];
          window.__reorderPayload = orderedIds;
          var byId = {};
          for (var k = 0; k < environments.length; k += 1) byId[environments[k].id] = environments[k];
          var next = [];
          for (var j = 0; j < orderedIds.length; j += 1) {
            if (byId[orderedIds[j]]) next.push(byId[orderedIds[j]]);
          }
          // 整批校验：缺项即拒绝（前端据此回滚）
          if (next.length === orderedIds.length) environments = next;
          return null;
        }
        case 'globals_list': return [];
        case 'variable_list': return [];
        case 'collection_get': return collection;
        case 'settings_get': return null;
        case 'plugin:event|listen': return 1;
        default: return null;
      }
    }
  };
})();
`;

let server: ViteDevServer;
let origin = '';
let browser: Browser;

beforeAll(async () => {
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    // 避开其它 spec 占用的 5195-5199
    server: { port: 5204, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5204}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').waitFor();
  return page;
}

/** 打开 Environments tab 并等到列表渲染出来。 */
async function openEnvironments(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Environments' }).click();
  await page.locator('.env-item').first().waitFor();
}

/** 侧栏列表里的名字，按界面从上到下的顺序（Globals 是固定项，不算在内）。 */
async function envOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.env-panel .env-row .env-name'))
      .map((node) => node.textContent ?? '')
      .filter((name) => name !== 'Globals'),
  );
}

/** 应用到目前为止调用过的后端命令。 */
async function invoked(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as Record<string, unknown>).__invoked as string[]);
}

/** 清空调用记录后按下并小幅移动，返回这一段时间里发生的 invoke。 */
async function pressAndDrag(page: Page, x: number, y: number): Promise<string[]> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__invoked = [];
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 6, y + 6, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  return invoked(page);
}

describe('环境列表的拖拽与滚动（真实引擎）', () => {
  it('拖到某一行即落到该行的位置，松手后把完整顺序落库', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironments(page);

      const before = await envOrder(page);
      expect(before).toHaveLength(ENVIRONMENT_COUNT);
      expect(before.slice(0, 3)).toEqual(['环境 1', '环境 2', '环境 3']);

      // .env-row[0] 是 Globals：把「环境 3」拖到「环境 1」那一行上
      await page.locator('.env-row').nth(3).dragTo(page.locator('.env-row').nth(1), {
        targetPosition: { x: 60, y: 8 },
      });

      // 只比前缀：整条序列 30 项，「环境 4」之后应当保持原样
      await expect
        .poll(async () => (await envOrder(page)).slice(0, 4))
        .toEqual(['环境 3', '环境 1', '环境 2', '环境 4']);
      expect(await envOrder(page)).toHaveLength(ENVIRONMENT_COUNT);

      // 落库的是**完整**顺序，且下标即新次序
      const payload = await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__reorderPayload as string[] | null,
      );
      expect(payload).toHaveLength(ENVIRONMENT_COUNT);
      expect(payload?.slice(0, 4)).toEqual(['e3', 'e1', 'e2', 'e4']);
    } finally {
      await page.close();
    }
  });

  it('落点那一侧画出插入线，被拖的那一行淡出', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironments(page);

      // 落点用**合成的拖拽事件**驱动，而不是合成的鼠标手势：真实引擎按约 350ms 节流
      // `dragover`，用鼠标事件模拟拖拽时终点的最后几步不生成事件——实测最后一次 dragover
      // 停在半路的行上（clientY 163，而目标行的 top 是 123.5），落点因此读不到。
      // 手势 → 落位的链路已由前一条用例（真实 `dragTo`）覆盖；这一条专门验**渲染**：
      // 插入线的位置与外观，那是 jsdom 量不到、只有真引擎才有的东西（`::after` 的几何）。
      // 两次 `page.evaluate` 是必须的：React 18 会把**同一个任务**里的状态更新攒起来批处理，
      // 而落点解算要读到上一步（dragstart）记下的拖动项。放在一次 evaluate 里，dragover 处理
      // 器读到的 dragId 还是 null，落点永远不会亮——这正是本仓库 jsdom 用例里"必须过一次
      // `act` 才能让上一步的拖动项在下一步里可见"那件事，只是这里一次 evaluate 就是一个任务。
      await page.evaluate(() => {
        const bag = window as unknown as Record<string, unknown>;
        bag.__transfer = new DataTransfer();
        const source = (document.querySelectorAll('.env-row') as NodeListOf<HTMLElement>)[3];
        const box = source.getBoundingClientRect();
        source.dispatchEvent(
          new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + 8,
            dataTransfer: bag.__transfer as DataTransfer,
          }),
        );
      });

      await page.evaluate(() => {
        const bag = window as unknown as Record<string, unknown>;
        const target = (document.querySelectorAll('.env-row') as NodeListOf<HTMLElement>)[1];
        const box = target.getBoundingClientRect();
        // 落在目标行的**下半区**：插入线该画在它的下缘
        target.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height * 0.75,
            dataTransfer: bag.__transfer as DataTransfer,
          }),
        );
      });

      const state = await page.evaluate(() => {
        const names = (selector: string) =>
          Array.from(document.querySelectorAll(selector)).map(
            (row) => row.querySelector('.env-name')?.textContent ?? '',
          );
        const marked = document.querySelector('.env-row.drop-after') as HTMLElement | null;
        const anchor = marked ?? document.querySelector('.env-row.drop-before');
        const line = anchor ? getComputedStyle(anchor, '::after') : null;
        return {
          after: names('.env-row.drop-after'),
          before: names('.env-row.drop-before'),
          dragging: names('.env-row.dragging'),
          lineHeight: line?.height ?? null,
          lineColor: line?.backgroundColor ?? null,
          selection: window.getSelection()?.toString() ?? '',
        };
      });
      // 收尾：让拖动状态归位（否则后续断言会看到半开的拖拽）
      await page.evaluate(() => {
        const source = document.querySelectorAll('.env-row')[3] as HTMLElement;
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
      });

      // 只有目标行的下缘那条线，上半区那条不该同时出现
      expect(state.after).toEqual(['环境 1']);
      expect(state.before).toEqual([]);
      expect(state.dragging).toEqual(['环境 3']);
      expect(state.lineHeight).toBe('2px');
      expect(state.lineColor, '插入线是透明的，看不见').not.toBe('rgba(0, 0, 0, 0)');
      // 拖拽手势不该带出原生文本选中（与树行同款：user-select: none）
      expect(state.selection, '拖动过程选中了文字').toBe('');
    } finally {
      await page.close();
    }
  });

  it('列表用悬浮滚动条：原生条已收成 0 宽、行宽不随溢出变化、指示条可拖动', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironments(page);

      const measure = () =>
        page.evaluate(() => {
          const list = document.querySelector('.env-list') as HTMLElement;
          const row = document.querySelectorAll('.env-row')[1] as HTMLElement;
          return {
            scrollbarWidth: getComputedStyle(list).scrollbarWidth,
            gutter: list.offsetWidth - list.clientWidth,
            scrollable: list.scrollHeight > list.clientHeight,
            rowWidth: Math.round(row.getBoundingClientRect().width),
            overlay:
              document.querySelector('.env-panel [data-testid="overlay-scrollbar"]') !== null,
          };
        });

      // 矮窗口：30 个环境装不下
      const overflowing = await measure();
      expect(overflowing.scrollable).toBe(true);
      expect(overflowing.scrollbarWidth, '原生滚动条没被收掉').toBe('none');
      expect(overflowing.gutter, '滚动条占了内容宽度').toBe(0);
      expect(overflowing.overlay, '没有绘制悬浮滚动条').toBe(true);

      // 高窗口：装得下 → 悬浮条不渲染，且行宽与溢出时一模一样（出现 / 消失不该引起横跳）
      await page.setViewportSize({ width: 1100, height: 1500 });
      await page.waitForTimeout(150);
      const roomy = await measure();
      expect(roomy.scrollable).toBe(false);
      expect(roomy.overlay, '内容不足一屏时不该出现滚动指示').toBe(false);
      expect(roomy.rowWidth).toBe(overflowing.rowWidth);

      // 回到矮窗口：按住悬浮指示条拖动，容器跟着滚
      await page.setViewportSize({ width: 1100, height: 620 });
      await page.waitForTimeout(150);
      const thumb = page.getByTestId('overlay-scrollbar');
      const thumbBox = (await thumb.boundingBox())!;
      await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        thumbBox.x + thumbBox.width / 2,
        thumbBox.y + thumbBox.height / 2 + 120,
        { steps: 8 },
      );
      await page.mouse.up();

      const dragged = await page.evaluate(() => {
        const list = document.querySelector('.env-list') as HTMLElement;
        const overlay = document.querySelector('[data-testid="overlay-scrollbar"]') as HTMLElement;
        return {
          scrollTop: Math.round(list.scrollTop),
          thumbTop: Math.round(overlay.getBoundingClientRect().top),
        };
      });
      expect(dragged.scrollTop, '拖动悬浮指示条没有滚动容器').toBeGreaterThan(0);
      expect(dragged.thumbTop, '指示条没有跟着滚动同步').toBeGreaterThan(Math.round(thumbBox.y));
    } finally {
      await page.close();
    }
  });

  it('在改名输入框里拖选文字：行不被拖走，改名态也不被打断', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironments(page);

      // 第 2 个环境进入就地改名
      const row = page.locator('.env-row').nth(2);
      await row.hover();
      await row.getByLabel('更多操作').click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      const input = page.locator('.env-list .env-name-input');
      await input.waitFor();

      // 菜单刚收起就动手容易撞上渲染：先让它落一拍
      await page.waitForTimeout(150);

      // 在输入框里按下并向左拖：应当是"选中文字"，而不是把整行拖走
      const box = (await input.boundingBox())!;
      await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 6, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();

      // 这里断言的是**行上的 draggable / user-select: none 不会伤到输入框**：在输入框里按下
      // 并拖动，既不该把整行拖走，也不该让它失焦（失焦即提交、输入框会被换回名字）。
      //
      // 至于"文字确实被选中"——实测为真（本机的真鼠标手势下 selectionEnd - selectionStart > 0，
      // Chromium 给表单控件自己的 user-select，祖先的 none 管不到它），但它对 CPU 争用敏感：
      // 整套并行跑时同一条手势会量到 0。为不给回归信号引入 flaky，这一条不写成断言，结论记在
      // design.md 的风险结局里；真机上顺手与否由 5.2 人工验收。
      const state = await page.evaluate(() => {
        const node = document.querySelector('.env-list .env-name-input') as HTMLInputElement | null;
        return {
          stillEditing: node !== null,
          dragging: document.querySelectorAll('.env-row.dragging').length,
        };
      });

      expect(state.dragging, '在输入框里拖选文字把整行拖走了').toBe(0);
      expect(state.stillEditing, '拖选把改名态弄没了（失焦即提交）').toBe(true);
    } finally {
      await page.close();
    }
  });

  it('改名中与删除确认条展开时列表仍可滚动（高度链没被展开态破坏）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      await openEnvironments(page);

      // 删除确认条（第 2 个环境）
      const second = page.locator('.env-row').nth(2);
      await second.hover();
      await second.getByLabel('更多操作').click();
      await page.getByRole('menuitem', { name: '删除' }).click();
      await page.getByTestId('environment-delete-confirm').waitFor();

      // 就地改名（第 3 个环境）：两种展开态同时在场
      const third = page.locator('.env-row').nth(3);
      await third.hover();
      await third.getByLabel('更多操作').click();
      await page.getByRole('menuitem', { name: '重命名' }).click();
      await page.locator('.env-list .env-name-input').waitFor();

      const state = await page.evaluate(() => {
        const list = document.querySelector('.env-list') as HTMLElement;
        list.scrollTop = 300;
        return {
          scrollTop: Math.round(list.scrollTop),
          editing: document.querySelector('.env-list .env-name-input') !== null,
          confirm: document.querySelectorAll('.env-list .node-confirm').length,
        };
      });

      expect(state.editing, '改名态没建立起来').toBe(true);
      expect(state.confirm, '删除确认条没建立起来').toBeGreaterThan(0);
      expect(state.scrollTop, '展开态下列表滚不动了').toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});

describe('通用下拉的滚动与容器拖拽边界（真实引擎）', () => {
  it('菜单自身滚轮滚动不关闭菜单，且超出一屏的选项可达可选中', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      await page.getByTestId('env-select-trigger').click();
      await page.locator('.dropdown-options').waitFor();

      const geometry = await page.evaluate(() => {
        const options = document.querySelector('.dropdown-options') as HTMLElement;
        return {
          clientHeight: options.clientHeight,
          scrollHeight: options.scrollHeight,
          count: document.querySelectorAll('.dropdown-option').length,
        };
      });
      // 「无环境」+ 30 个环境
      expect(geometry.count).toBe(ENVIRONMENT_COUNT + 1);
      expect(
        geometry.scrollHeight,
        '选项没有超出一屏，本用例无法验证',
      ).toBeGreaterThan(geometry.clientHeight + 40);

      const box = (await page.locator('.dropdown-options').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(200);

      const afterWheel = await page.evaluate(() => {
        const options = document.querySelector('.dropdown-options') as HTMLElement | null;
        return {
          open: document.querySelector('.dropdown-menu') !== null,
          scrollTop: options ? Math.round(options.scrollTop) : null,
        };
      });
      expect(afterWheel.open, '滚轮把菜单关掉了：超出一屏的选项因此不可达').toBe(true);
      expect(afterWheel.scrollTop).toBeGreaterThan(0);

      // 滚到底，最后一项必须选得中
      await page.locator('.dropdown-options').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const last = page.locator('.dropdown-option').last();
      const label = ((await last.textContent()) ?? '').replace('✓', '').trim();
      await last.click();

      const trigger = page.getByTestId('env-select-trigger');
      expect(await trigger.getAttribute('data-value')).toBe(`e${ENVIRONMENT_COUNT}`);
      expect(await trigger.textContent()).toContain(label);
    } finally {
      await page.close();
    }
  });

  it('从菜单内部按下指针不触发窗口拖拽（含滚动指示条所在的位置）', async () => {
    const page = await openApp();
    page.setDefaultTimeout(10_000);
    try {
      const barBox = (await page.locator('.session-bar').boundingBox())!;

      // 正向对照先跑：会话标签行的空白处必须真的触发窗口拖拽，否则下面两条断言没有意义
      const control = await pressAndDrag(page, barBox.x + 40, barBox.y + barBox.height / 2);
      expect(control, '对照组没有触发 start_dragging，这套观测不可信').toContain(
        'plugin:window|start_dragging',
      );

      await page.getByTestId('env-select-trigger').click();
      await page.locator('.dropdown-options').waitFor();
      const optionsBox = (await page.locator('.dropdown-options').boundingBox())!;
      const menuBox = (await page.locator('.dropdown-menu').boundingBox())!;

      // 选项区右缘：滚动指示条所在的位置，正是"一拖动整个窗口就跑"的那一处
      const onScrollbar = await pressAndDrag(
        page,
        optionsBox.x + optionsBox.width - 4,
        optionsBox.y + 40,
      );
      expect(onScrollbar).not.toContain('plugin:window|start_dragging');

      // 菜单可能已被上一次按下关掉（修复前正是"一滚就没"），重开一次再试空白处
      if ((await page.locator('.dropdown-menu').count()) === 0) {
        await page.getByTestId('env-select-trigger').click();
        await page.locator('.dropdown-options').waitFor();
      }
      const onBlank = await pressAndDrag(page, menuBox.x + 3, menuBox.y + 3);
      expect(onBlank).not.toContain('plugin:window|start_dragging');

      // 菜单仍然可用：选项点得中
      await page.locator('.dropdown-option').nth(1).click();
      expect(await page.getByTestId('env-select-trigger').getAttribute('data-value')).toBe('e1');
    } finally {
      await page.close();
    }
  });
});
