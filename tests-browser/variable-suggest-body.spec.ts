// Body raw（Monaco）的变量候选（change: suggest-variables-in-body-editor，任务 3.1）。
//
// 为什么只能在真 Blink 里验：Monaco 在 happy-dom 跑不了（tests/setup.ts 把 CodeSurface
// mock 掉了），而这里要验的正是「敲下 `{{` 之后编辑器自己弹出补全面板、回车把候选写回
// 正文」——触发时机、过滤、键盘都在编辑器内部。判定与过滤的纯逻辑已被单测覆盖
//（tests/variableSuggest.test.ts），这里只负责把它们与 Monaco 接起来的那一层。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

// 端口避开 tauri dev（1420）与其它 browser 用例已占用的 5187–5207
const PORT = 5208;

/** 请求体 raw 的模型 URI（与 harness 的 `hoverBodyUri` 同构）。 */
const hoverBodyUri = (request: string) => `file:///reqman/harness/request/${request}/body`;

/**
 * harness 里请求体正文的站位。
 *
 * 新打 `{{` 一律落在第 3 行的行尾：那一处前后都没有现成的花括号，判定不会歧义。
 * 第 2 行的 `{{host}}` 起于第 12 列，用来验「在已写好的占位符里改名字」。
 */
const TOKEN_LINE_END = { line: 3, column: 23 };
const INSIDE_HOST = { line: 2, column: 14 };

interface Point {
  x: number;
  y: number;
}

/** 调 harness 暴露的驱动钩子。 */
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

/** 补全面板里可见的候选项（「名字 + 来源」两行拼起来）。 */
function suggestRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const widget = document.querySelector('.suggest-widget.visible');
    if (!widget) return [];
    return Array.from(widget.querySelectorAll('.monaco-list-row')).map(
      (row) => (row as HTMLElement).innerText,
    );
  });
}

describe('请求体 raw 的变量候选（Monaco in Blink）', () => {
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

  async function openHarness(): Promise<Page> {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests-browser/code-surface-harness.html`);
    await page.waitForFunction(() => Boolean((window as unknown as { __surface__?: unknown }).__surface__), undefined, {
      timeout: 30_000,
    });
    await page.waitForSelector('.monaco-editor', { timeout: 30_000 });
    return page;
  }

  /** 挂出请求体面并等它就绪（编辑面是懒加载的：坐标算得出来才算挂好）。 */
  async function mountBody(page: Page, request = 'req-1'): Promise<string> {
    const uri = hoverBodyUri(request);
    await invoke(page, 'mountHoverBody', request);

    for (let attempt = 0; attempt < 80; attempt++) {
      const point = await invoke<Point | null>(
        page,
        'hoverPointAt',
        uri,
        TOKEN_LINE_END.line,
        TOKEN_LINE_END.column,
      );
      if (point) return uri;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`请求体编辑面没有挂出来：${request}`);
  }

  /** 把光标放到正文的某个字符上（点击即定位光标）。 */
  async function clickAt(page: Page, uri: string, spot: Point): Promise<void> {
    const point = await invoke<Point | null>(page, 'hoverPointAt', uri, spot.line, spot.column);
    expect(point, '应算得出该字符的页面坐标').not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
  }

  /**
   * 停在某一行的行尾并键入一段文本。
   *
   * 为什么是行尾：`suggestContext` 回溯的是「最近的一对 `{{`」。若正好敲在现成的 `{` 前面，
   * 文本会变成 `{{{`、最近的一对落在光标之后，判定为「光标在两个花括号之间」——这不是用户
   * 的日常站位（正文里的变量几乎都写在引号里），因此用例不去制造那个形状。
   */
  async function typeAtLineEnd(
    page: Page,
    uri: string,
    spot: Point,
    text: string,
  ): Promise<void> {
    await clickAt(page, uri, spot);
    await page.keyboard.press('End');
    await page.keyboard.type(text);
  }

  it('键入 `{{` 就在光标处弹出候选：名字 + 取值 + 来源', async () => {
    const page = await openHarness();
    const uri = await mountBody(page);

    await typeAtLineEnd(page, uri, TOKEN_LINE_END, '{{');

    await page.waitForFunction(
      () => Boolean(document.querySelector('.suggest-widget.visible')),
      undefined,
      { timeout: 15_000 },
    );

    const rows = await suggestRows(page);
    const text = rows.join(' | ');
    // 取名与来源由 harness 的假源给出（req-1：host / token，都在环境作用域）
    expect(text, `候选应含 host 与 token，实际：${text}`).toContain('host');
    expect(text).toContain('token');
    expect(text).toContain('环境');
    // 值的呈现：面板里要看得见当前取值，而不是只给名字
    expect(text).toContain('one.test');

    await page.close();
  });

  it('回车把选中的候选写回正文：补成完整的 `{{host}}`', async () => {
    const page = await openHarness();
    const uri = await mountBody(page);

    await typeAtLineEnd(page, uri, TOKEN_LINE_END, '{{');
    await page.waitForFunction(() => Boolean(document.querySelector('.suggest-widget.visible')), undefined, {
      timeout: 15_000,
    });

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const value = await invoke<string>(page, 'hoverBodyValue');
    expect(value, `正文应补出完整的 {{host}}，实际：${JSON.stringify(value)}`).toContain('",{{host}}');
    // `}}` 由候选补上，用户不必再敲；也不该留下第三对花括号
    expect(value).not.toContain('{{{{');
    expect(await suggestRows(page)).toEqual([]);

    await page.close();
  });

  it('单敲一个 `{` 不弹变量候选（它还没构成 `{{`）', async () => {
    const page = await openHarness();
    const uri = await mountBody(page);

    await typeAtLineEnd(page, uri, TOKEN_LINE_END, '{');
    await page.waitForTimeout(1200);

    // 断言的是「我们没接这一下」：面板里不出现任何变量条目。JSON 语言服务是否顺带弹它
    // 自己的候选不在本用例的范围内，因此只看我们那两条名字在不在。
    const rows = await suggestRows(page);
    expect(rows.join(' | ')).not.toContain('host');
    expect(rows.join(' | ')).not.toContain('token');

    await page.close();
  });

  it('在已写好的占位符里改名字：替换整个占位符，不产生嵌套花括号', async () => {
    const page = await openHarness();
    const uri = await mountBody(page);

    // 光标落在 `{{host}}` 的花括号内（第 2 行第 14 列），直接唤出补全
    await clickAt(page, uri, INSIDE_HOST);
    await page.keyboard.press('Control+Space');
    await page.waitForFunction(() => Boolean(document.querySelector('.suggest-widget.visible')), undefined, {
      timeout: 15_000,
    });

    // 候选顺序 = 取值源的顺序（host 在前、token 在后），下移一项即选中 token
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const value = await invoke<string>(page, 'hoverBodyValue');
    expect(value, `整行应换成 {{token}}，实际：${JSON.stringify(value)}`).toContain('"host": "{{token}}"');
    expect(value).not.toContain('{{{{');
    expect(value).not.toContain('{{host}}');

    await page.close();
  });
});
