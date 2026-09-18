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
  },
});
