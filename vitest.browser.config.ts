import { defineConfig } from 'vitest/config';

/**
 * 需要真实浏览器引擎的验证，单独一份配置：
 *
 *   npx playwright install chromium
 *   npm run test:browser
 *
 * 与默认的 `npm test` 分开，是为了让「需要浏览器」这件事显式可见，
 * 而不是让用例在缺少浏览器时静默跳过。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests-browser/**/*.spec.ts'],
    globals: true,
    testTimeout: 30_000,
    /**
     * 每个 spec 文件在 `beforeAll` 里自起一个 Vite dev server、再起一个浏览器，用例跑完又在
     * `afterAll` 里把它们关掉。默认的 10s 钩子超时在**并行**执行时不够：多个文件同时开合
     * server + 浏览器会互相争用，症状是一批文件的 `afterAll` 报 `Hook timed out in 10000ms`
     * ——而它们**单独跑都绿**（实测：sandbox 并行 42s 超时 / 单独 0.8s）。
     * 60s 是给这一步的余量；用例本身的 30s 上限不动。
     */
    hookTimeout: 60_000,
  },
});
