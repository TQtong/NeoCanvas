import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Vitest 单元与组件测试配置。 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['lib/**/*.ts', 'stores/**/*.ts'],
      exclude: ['lib/supabase/**'],
    },
  },
});
