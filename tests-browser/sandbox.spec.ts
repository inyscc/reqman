// 在真实浏览器引擎里验证「不可信响应预览」依赖的隔离原语（任务 7.3）。
//
// 前端的组件测试断言了「我们确实用了 sandbox="" + blob 承载」；这里验证该原语
// 在真实引擎中的行为：不执行脚本、无法触达父页面。第二个用例是**正对照**——
// 加上 allow-scripts 后脚本必须被执行，用来证明本检测确实能发现脚本执行，
// 否则第一个用例的通过毫无意义。

import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

/**
 * 把字符串安全地嵌进内联 `<script>`。
 *
 * 只做 `JSON.stringify` 是不够的：payload 自身就含有 `</script>`，而 HTML 解析器不
 * 认识 JS 字符串字面量——它在内联脚本里遇到第一个 `</script` 就结束整个 script 元素，
 * 宿主脚本因此被截断成语法错误，后面一行都不会执行。转义 `\/` 之后，脚本里读到的
 * 字符串值不变，而 HTML 解析器再也看不到 `</script`。
 */
function embed(value: string): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

/**
 * 构造一个宿主页面：用给定的 sandbox 值把 payload 装进 iframe。
 *
 * blob 的类型与 `src/lib/sandbox.ts` 的 `createSandboxUrl` 保持一致（带 `charset=utf-8`）：
 * 不带字符集时 iframe 会按默认单字节编码解析，中文正文会变成乱码，用例就会在
 * 「页面结构被展示」这一步失败——那验证的是别的东西，不是本文件要验的隔离。
 */
function hostPage(payload: string, sandbox: string): string {
  return `<!doctype html><html><body>
<script>
  window.received = [];
  window.addEventListener('message', (event) => window.received.push(event.data));
  const url = URL.createObjectURL(new Blob([${embed(payload)}], { type: 'text/html;charset=utf-8' }));
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', ${embed(sandbox)});
  frame.src = url;
  document.body.appendChild(frame);
</script>
</body></html>`;
}

const PAYLOAD = `<html><body><p id="marker">结构可见</p>
<script>
  parent.postMessage('script-ran', '*');
  try { parent.document.body.setAttribute('data-escaped', 'yes'); } catch (error) { /* 跨来源被拦 */ }
</script>
</body></html>`;

describe('隔离承载在真实浏览器中的行为', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('sandbox 为空时，脚本不执行，也无法修改父页面', async () => {
    const page = await browser.newPage();
    await page.setContent(hostPage(PAYLOAD, ''));

    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    expect(frame, '应存在承载预览的子框架').toBeTruthy();

    // 页面结构被展示
    await expect(frame!.locator('#marker').textContent()).resolves.toBe('结构可见');

    // 脚本没有执行
    expect(await page.evaluate(() => (globalThis as never as { received: string[] }).received)).toEqual([]);

    // 也没有触达父页面
    expect(await page.evaluate(() => document.body.getAttribute('data-escaped'))).toBeNull();

    await page.close();
  });

  it('正对照：授予 allow-scripts 后脚本会被执行，证明本检测有效', async () => {
    const page = await browser.newPage();
    await page.setContent(hostPage(PAYLOAD, 'allow-scripts'));

    await page.waitForFunction(
      () => (globalThis as never as { received: string[] }).received.length > 0,
      undefined,
      { timeout: 5_000 },
    );

    const received = await page.evaluate(
      () => (globalThis as never as { received: string[] }).received,
    );
    expect(received).toContain('script-ran');

    // 即使脚本能跑，不带 allow-same-origin 时仍改不动父页面
    expect(await page.evaluate(() => document.body.getAttribute('data-escaped'))).toBeNull();

    await page.close();
  });
});
