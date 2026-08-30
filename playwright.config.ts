import { defineConfig, devices } from '@playwright/test';

/** 浏览器端核心流程、双页面 Realtime 与性能测试配置。 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [
        ['line'],
        ['junit', { outputFile: 'test-results/playwright.xml' }],
        ['html', { open: 'never' }],
      ]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'test-results/.auth/user.json',
      },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:3100/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        // 精准编辑用例不能依赖开发者机器上的本地开关状态。
        NEXT_PUBLIC_IMAGE_EDITING_ENABLED: 'true',
        // 与 Edge 的 NEOCANVAS_TEST_MODE 双重守卫，允许确定性模型覆盖全部操作。
        NEXT_PUBLIC_NEOCANVAS_TEST_MODE: 'true',
      },
    },
    {
      command: 'node scripts/serve-edge-tests.mjs',
      url: 'http://127.0.0.1:54321/functions/v1/process-generation-queue',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
