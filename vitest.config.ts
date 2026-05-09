import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // Vitest only runs src/**/*.test.{ts,tsx}. Playwright e2e specs in
    // tests/e2e/ are excluded — they're driven by `npx playwright test`.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
