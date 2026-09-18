// 浏览器启动的统一入口。
//
// 主路径是 Playwright 自带的那份 Chromium（`npx playwright install chromium`，与 CI 一致）。
// 但开发机上经常只装了 Chrome 或 Edge，此时若坚持自带版本，「本机跑不了浏览器用例」就会变成
// 绕过验证的理由——而脚本运行时的问题恰恰**只在真浏览器里**暴露（1.5 的 CSP/eval、1.6 的预览
// 编码、1.3 的 Worker 继承、D17 的冻结原型，四次教训都属于这一类）。
//
// 因此都不可用时按顺序退回本机已安装的浏览器。退回的 Chrome / Edge 与 WebView2 同属 Blink，
// 结论可沿用；但版本与自带的那份不同，**发布基线仍应以 `npx playwright install chromium`
// 加自带 Chromium 为准**——本层只负责「有浏览器可用」，不负责抹平版本差异。

import { chromium, type Browser } from 'playwright';

/** 依次尝试：Playwright 自带 Chromium → 本机 Chrome → 本机 Edge。 */
const ATTEMPTS: { label: string; channel?: 'chrome' | 'msedge' }[] = [
  { label: 'Playwright 自带 Chromium' },
  { label: '本机 Chrome', channel: 'chrome' },
  { label: '本机 Edge', channel: 'msedge' },
];

let announced = false;

/** 启动一个可用的浏览器；都不可用时把三者的失败原因一并抛出。 */
export async function launchBrowser(): Promise<Browser> {
  const failures: string[] = [];

  for (const attempt of ATTEMPTS) {
    try {
      const browser = await chromium.launch(attempt.channel ? { channel: attempt.channel } : {});
      if (!announced) {
        announced = true;
        console.log(`[browser] ${attempt.label} ${browser.version()}`);
      }
      return browser;
    } catch (error) {
      failures.push(`${attempt.label}：${String(error && (error as Error).message).split('\n')[0]}`);
    }
  }

  throw new Error(
    [
      '没有可用的浏览器：',
      ...failures,
      '请运行 `npx playwright install chromium`，或安装 Chrome / Edge。',
    ].join('\n'),
  );
}
