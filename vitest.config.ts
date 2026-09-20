import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    // happy-dom 跑不了 Monaco：在 setup 里把 CodeSurface 换成保形 mock（design 决策 8）
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    restoreMocks: true,
  },
});
