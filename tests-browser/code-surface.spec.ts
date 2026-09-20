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
});
