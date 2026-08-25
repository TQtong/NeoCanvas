import { expect, test } from '@playwright/test';
import { addTextNode, createBlankProject, createGeneratedProject, waitForSaved } from './helpers';

test.describe('设计工作台核心旅程', () => {
  test('创建、确定性生成、刷新、重命名及折叠均保持状态', async ({ page }) => {
    const prompt = `E2E 主流程 ${crypto.randomUUID()}`;
    await createGeneratedProject(page, prompt);

    const panel = page.locator('#project-chat-panel');
    const expandedBox = await panel.boundingBox();
    expect(expandedBox?.width).toBeGreaterThanOrEqual(375);
    expect(expandedBox?.width).toBeLessThanOrEqual(385);
    await expect(panel.getByText(prompt, { exact: true })).toBeVisible();

    // 流水线可能在首屏加载前已经完成，也可能先显示占位；最终只能存在一份真实产出。
    await expect(page.locator('.react-flow__node-image')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.react-flow__node-generation_placeholder')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.react-flow__node-image')).toHaveCount(1);
    await expect(panel.getByText(prompt, { exact: true })).toHaveCount(1);

    const draft = panel.getByPlaceholder('Start with an idea, or type "@" to mention');
    await draft.fill('折叠后仍应保留的草稿');
    await page.locator('header.glass').getByRole('button', { name: '收起面板' }).click();
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await page.locator('header.glass').getByRole('button', { name: '展开面板' }).click();
    await expect(draft).toHaveValue('折叠后仍应保留的草稿');

    const titleButton = page.locator('header.glass button[title="重命名项目"]');
    await titleButton.dblclick();
    const titleInput = page.getByRole('textbox', { name: '重命名项目' });
    await titleInput.fill('E2E 稳定工作台');
    await titleInput.press('Enter');
    await expect(titleButton).toHaveText('E2E 稳定工作台');
    await page.reload();
    await expect(page.locator('header.glass button[title="重命名项目"]')).toHaveText(
      'E2E 稳定工作台',
    );
  });

  test('确定性 Provider 失败后收敛为可重试状态且刷新不丢失', async ({ page }) => {
    const prompt = `[[fatal]] E2E 失败路径 ${crypto.randomUUID()}`;
    await createGeneratedProject(page, prompt);

    const placeholder = page.locator('.react-flow__node-generation_placeholder');
    await expect(placeholder.getByText('生成失败')).toBeVisible({ timeout: 30_000 });
    await expect(placeholder.getByRole('button', { name: '重试' })).toBeVisible();
    await expect(page.locator('.react-flow__node-image')).toHaveCount(0);

    await page.reload();
    await expect(placeholder.getByText('生成失败')).toBeVisible({ timeout: 20_000 });
    await expect(placeholder.getByRole('button', { name: '重试' })).toBeVisible();
    await expect(page.locator('.react-flow__node-image')).toHaveCount(0);
  });

  test('双页面 Realtime 同步节点、消息和生成终态且不重复', async ({ browser, page }) => {
    const projectId = await createBlankProject(page);
    const secondContext = await browser.newContext({
      storageState: 'test-results/.auth/user.json',
    });
    const secondPage = await secondContext.newPage();
    try {
      await secondPage.goto(`/p/${projectId}`);
      await expect(secondPage.locator('#project-chat-panel')).toBeVisible();

      await addTextNode(page, '来自页面 A 的实时节点');
      await waitForSaved(page);
      await expect(secondPage.locator('.react-flow__node-text')).toContainText(
        '来自页面 A 的实时节点',
        { timeout: 20_000 },
      );

      const prompt = `双页面实时消息 ${crypto.randomUUID()}`;
      const secondInput = secondPage.getByPlaceholder('Start with an idea, or type "@" to mention');
      await secondInput.fill(prompt);
      await secondInput.press('Enter');
      await expect(
        page.locator('#project-chat-panel').getByText(prompt, { exact: true }),
      ).toHaveCount(1, { timeout: 20_000 });
      await expect(secondPage.locator('.react-flow__node-image')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(page.locator('.react-flow__node-image')).toHaveCount(1, { timeout: 20_000 });
    } finally {
      await secondContext.close();
    }
  });

  test('浏览器写请求中断后由 IndexedDB outbox 跨刷新恢复并最终落库', async ({ page }) => {
    await createBlankProject(page);
    await addTextNode(page, '离线前文本');
    await waitForSaved(page);

    const restPattern = '**/rest/v1/canvas_nodes*';
    await page.route(restPattern, async (route) => {
      if (['POST', 'PATCH', 'DELETE'].includes(route.request().method())) await route.abort();
      else await route.continue();
    });

    const node = page.locator('.react-flow__node-text').last();
    await node.dblclick();
    const editor = node.locator('textarea');
    await editor.fill('离线刷新后必须恢复的最终文本');
    await editor.press('Escape');
    await expect(
      page.locator('header.glass').getByRole('button', { name: /离线|保存失败/ }),
    ).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.locator('.react-flow__node-text')).toContainText(
      '离线刷新后必须恢复的最终文本',
      { timeout: 20_000 },
    );

    await page.unroute(restPattern);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForSaved(page);
    await page.reload();
    await expect(page.locator('.react-flow__node-text')).toContainText(
      '离线刷新后必须恢复的最终文本',
    );
  });
});
