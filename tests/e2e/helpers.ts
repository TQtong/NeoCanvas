import { expect, type Page } from '@playwright/test';

/** 从设计页 URL 提取项目 UUID。 */
export function projectIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/^\/p\/([0-9a-f-]{36})$/i);
  if (!match) throw new Error(`不是设计页 URL：${url}`);
  return match[1]!;
}

/** 通过主页真实服务端动作创建一个进入即生成的项目。 */
export async function createGeneratedProject(page: Page, prompt: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '选择模型' })).toContainText('NeoCanvas E2E Image');
  await page.getByPlaceholder('让 NeoCanvas 设计一张美丽的婚礼海报').fill(prompt);
  await page.getByRole('button', { name: '发送' }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/i, { timeout: 30_000 });
  await expect(page.locator('#project-chat-panel')).toBeVisible();
  return projectIdFromUrl(page.url());
}

/** 通过主页“新建项目”卡片创建不依赖 Provider 的空白项目。 */
export async function createBlankProject(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/i, { timeout: 30_000 });
  await expect(page.locator('#project-chat-panel')).toBeVisible();
  return projectIdFromUrl(page.url());
}

/** 在画布可视区域落一个文本节点并提交文本编辑。 */
export async function addTextNode(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: '文本', exact: true }).click();
  const pane = page.locator('.react-flow__pane');
  await pane.click({ position: { x: 420, y: 300 } });
  const editor = page.locator('.react-flow__node-text textarea').last();
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.press('Escape');
  await expect(page.locator('.react-flow__node-text').last()).toContainText(text);
}

/** 等待顶部保存状态收敛为“已保存”。 */
export async function waitForSaved(page: Page): Promise<void> {
  await expect(page.locator('header.glass').getByRole('button', { name: '已保存' })).toBeVisible({
    timeout: 30_000,
  });
}
