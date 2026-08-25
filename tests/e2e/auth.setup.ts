import { expect, test as setup } from '@playwright/test';
import { E2E_EMAIL } from './environment';

const authFile = 'test-results/.auth/user.json';

setup('使用本地 Mailpit 完成真实 Supabase 会话登录', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill(E2E_EMAIL);
  await page.getByRole('button', { name: '发送登录链接' }).click();
  await expect(page).toHaveURL('/', { timeout: 30_000 });
  await expect(page.getByText('NeoCanvas 让设计更简单')).toBeVisible();
  await page.context().storageState({ path: authFile });
});
