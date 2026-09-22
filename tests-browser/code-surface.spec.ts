import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

/**
 * CodeSurface 真身的验证（design 决策 8 的 `tests-browser` 层）。
 *
 * happy-dom 里 CodeSurface 被 mock 掉了（tests/setup.ts），真实行为——Monaco 渲染、
 * 行号、worker 补全、JSON 折叠、Ctrl+S 冒泡、非 ASCII 输入——只能在真实 Blink 里验。
 * 这里用 Vite 的 Node API 起进程内 dev server（与其它 browser 用例同一套做法），
 * 再打开 `code-surface-harness.html` 挂载组件真身并驱动它。
 */

// 端口避开 1420（tauri dev）与 5195–5199（其它 browser 用例）
const PORT = 5200;
const JS_URI = 'file:///reqman/harness/script.js';
const JSON_URI = 'file:///reqman/harness/body.json';
const RESPONSE_URI = 'file:///reqman/harness/response.json';

interface SurfaceApi {
  getValue(uri: string): string;
  foldingCount(uri: string): Promise<number>;
  saveCount(): number;
  setAppearance(patch: Record<string, unknown>): void;
  optionsOf(uri: string): Promise<{
    fontFamily: string;
    fontSize: number;
    tabSize: number | null;
    insertSpaces: boolean | null;
  } | null>;
  markEditor(uri: string): Promise<number>;
  markOf(uri: string): Promise<number | null>;
  foldAll(uri: string): Promise<void>;
  viewLineCount(uri: string): Promise<number>;
}

/** 缺省的等宽字体栈（与 `editorAppearance` 的 DEFAULT_EDITOR_APPEARANCE 一致）。 */
const DEFAULT_FONT_FAMILY =
  "'Cascadia Mono', Consolas, ui-monospace, SFMono-Regular, Menlo, monospace";

/** JSON 面的总行数（harness 的初值）：折叠后可见行数应小于它。 */
const JSON_TOTAL_LINES = 6;

/** 调 harness 暴露的驱动钩子：`invoke(page, 'optionsOf', uri)`。 */
function invoke<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ method, args }) => {
      const api = (
        window as unknown as { __surface__: Record<string, (...rest: unknown[]) => unknown> }
      ).__surface__;
      return api[method](...args);
    },
    { method, args },
  ) as Promise<T>;
}

describe('CodeSurface 真身（Monaco in Blink）', () => {
  let browser: Browser;
  let server: ViteDevServer;
  let origin = '';

  beforeAll(async () => {
    server = await createServer({
      root: process.cwd(),
      logLevel: 'error',
      server: { port: PORT, strictPort: true },
    });
    await server.listen();
    origin = `http://localhost:${server.config.server.port ?? PORT}`;
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function openHarness(): Promise<{ page: Page; errors: string[] }> {
    const errors: string[] = [];
    const page = await browser.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`${origin}/tests-browser/code-surface-harness.html`);
    await page.waitForFunction(
      () => Boolean((window as unknown as { __surface__?: unknown }).__surface__),
      undefined,
      { timeout: 30_000 },
    );
    // Monaco 真身渲染出来（编辑器 DOM 就绪）
    await page.waitForSelector('.monaco-editor', { timeout: 30_000 });
    return { page, errors };
  }

  it('渲染出 Monaco 并显示行号', async () => {
    const { page } = await openHarness();
    const editorCount = await page.locator('.monaco-editor').count();
    expect(editorCount, '应挂出三个编辑面').toBe(3);

    const lineNumbers = await page.locator('.margin-view-overlays .line-numbers').count();
    expect(lineNumbers, '行号应渲染').toBeGreaterThan(1);
    await page.close();
  });

  it('脚本面输入 pm.environment. 弹出补全，且面板不被容器裁切', async () => {
    const { page } = await openHarness();
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');

    await page.waitForSelector('.suggest-widget .monaco-list-row', { timeout: 15_000 });
    const rows = await page.locator('.suggest-widget .monaco-list-row').allInnerTexts();
    const labels = rows.join(' | ');
    expect(labels, `补全列表应含 pm.environment 成员，实际：${labels}`).toContain('set');
    expect(labels).toContain('get');

    // 面板要真的可见：宿主 `.code-surface` 刻意不设 overflow:hidden（Monaco 的浮层
    // 本就设计成可溢出编辑器，见 App.css 该段注释）。若哪天又被人加回裁切，
    // elementFromPoint 会命中裁它的祖先而不是面板自身，这条断言就会红。
    const hitInside = await page.evaluate(() => {
      const widget = document.querySelector('.suggest-widget') as HTMLElement | null;
      if (!widget) return false;
      const rect = widget.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + Math.min(rect.height / 2, 12),
      );
      return Boolean(hit) && widget.contains(hit);
    });
    expect(hitInside, '补全面板不应被容器裁切').toBe(true);
    await page.close();
  });

  it('JSON 面提供折叠范围', async () => {
    const { page } = await openHarness();
    const count = await page.evaluate(
      async (uri) => (window as unknown as { __surface__: SurfaceApi }).__surface__.foldingCount(uri),
      JSON_URI,
    );
    expect(count, '嵌套 JSON 应有可折叠范围').toBeGreaterThan(0);
    await page.close();
  });

  it('焦点在 Monaco 内按 Ctrl+S 仍冒泡到 window（app 的保存监听）', async () => {
    const { page } = await openHarness();
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+s');
    const count = await page.evaluate(() =>
      (window as unknown as { __surface__: SurfaceApi }).__surface__.saveCount(),
    );
    expect(count, 'Monaco 不应吞掉 Ctrl+S').toBeGreaterThan(0);
    await page.close();
  });

  it('只读响应正文不可编辑', async () => {
    const { page } = await openHarness();
    // harness 里第三个编辑面是只读响应正文
    const response = page.locator('.monaco-editor').nth(2);
    await response.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('MUTATED');
    const value = await page.evaluate(
      (uri) => (window as unknown as { __surface__: SurfaceApi }).__surface__.getValue(uri),
      RESPONSE_URI,
    );
    expect(value, '只读面内容不应被改动').toContain('"ok": true');
    expect(value).not.toContain('MUTATED');
    await page.close();
  });

  it('中文输入进入模型（非 ASCII 不被丢）', async () => {
    const { page } = await openHarness();
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('中文注释');
    const value = await page.evaluate(
      (uri) => (window as unknown as { __surface__: SurfaceApi }).__surface__.getValue(uri),
      JS_URI,
    );
    expect(value).toContain('中文注释');
    await page.close();
  });

  // 外观（change: add-editor-appearance-settings）：字体与字号走编辑器选项，缩进走模型
  // 选项；改动只 updateOptions，**不重建编辑器**——重建会丢滚动位置与折叠状态。
  describe('编辑器外观', () => {
    it('字体族与字号作用于已打开的编辑面', async () => {
      const { page } = await openHarness();

      const before = await invoke<{ fontFamily: string; fontSize: number } | null>(
        page,
        'optionsOf',
        JSON_URI,
      );
      expect(before?.fontSize, '缺省字号应为 12').toBe(12);
      expect(before?.fontFamily, '缺省应拿到系统等宽栈').toBe(DEFAULT_FONT_FAMILY);

      await invoke(page, 'setAppearance', { fontSize: 14, fontFamily: 'Menlo, monospace' });

      const after = await invoke<{ fontFamily: string; fontSize: number } | null>(
        page,
        'optionsOf',
        JSON_URI,
      );
      expect(after?.fontSize).toBe(14);
      expect(after?.fontFamily).toBe('Menlo, monospace');

      // 选项改了但渲染没跟上是最容易漏的一种：落到 DOM 上再确认一次
      const rendered = await page.evaluate(() => {
        const line = document.querySelector('.monaco-editor .view-line') as HTMLElement | null;
        return line ? getComputedStyle(line).fontSize : null;
      });
      expect(rendered).toBe('14px');
      await page.close();
    });

    it('缩进以设置为准：正文里的 2 空格缩进不覆盖「缩进数 4」', async () => {
      const { page } = await openHarness();

      // harness 的 JSON 初值是 2 空格缩进；开着 detectIndentation 时 tabSize 会变成 2
      const options = await invoke<{ tabSize: number | null; insertSpaces: boolean | null } | null>(
        page,
        'optionsOf',
        JSON_URI,
      );
      expect(options?.tabSize, '缩进数设置应盖过正文里的缩进').toBe(4);
      expect(options?.insertSpaces).toBe(true);

      await page.locator('.monaco-editor').nth(1).click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('Tab');

      const value = await invoke<string>(page, 'getValue', JSON_URI);
      expect(
        value.startsWith('    {'),
        `Tab 应插入 4 个空格，实际开头：${JSON.stringify(value.slice(0, 8))}`,
      ).toBe(true);
      await page.close();
    });

    it('缩进类型为 Tab 时按 Tab 插入制表符', async () => {
      const { page } = await openHarness();
      await invoke(page, 'setAppearance', { indentType: 'tab' });

      const options = await invoke<{ insertSpaces: boolean | null } | null>(
        page,
        'optionsOf',
        JSON_URI,
      );
      expect(options?.insertSpaces).toBe(false);

      await page.locator('.monaco-editor').nth(1).click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('Tab');

      const value = await invoke<string>(page, 'getValue', JSON_URI);
      expect(value.startsWith('\t'), '应插入一个制表符而不是 4 个空格').toBe(true);
      await page.close();
    });

    it('改外观不重建编辑器：实例与折叠状态都保持', async () => {
      const { page } = await openHarness();

      const mark = await invoke<number>(page, 'markEditor', JSON_URI);

      // 折叠范围是**异步**算出来的：先触发一次折叠模型（foldingCount 会 await 它），
      // 否则 foldAll 会无事发生；折完再等 DOM 真的少了几行。
      await invoke<number>(page, 'foldingCount', JSON_URI);
      await invoke(page, 'foldAll', JSON_URI);
      await page.waitForFunction(
        (total) => {
          const host = document.querySelectorAll('.monaco-editor')[1];
          return host ? host.querySelectorAll('.view-line').length < total : false;
        },
        JSON_TOTAL_LINES,
        { timeout: 5_000 },
      );
      const folded = await invoke<number>(page, 'viewLineCount', JSON_URI);
      expect(folded, '折叠后可见行数应少于总行数').toBeLessThan(JSON_TOTAL_LINES);

      await invoke(page, 'setAppearance', { fontSize: 15, indentCount: 8 });

      const markAfter = await invoke<number | null>(page, 'markOf', JSON_URI);
      expect(markAfter, '外观改动重建了编辑器（滚动与折叠会因此丢失）').toBe(mark);
      expect(await invoke<number>(page, 'viewLineCount', JSON_URI)).toBe(folded);
      await page.close();
    });
  });
});
