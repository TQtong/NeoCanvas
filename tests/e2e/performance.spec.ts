import { expect, test } from '@playwright/test';
import { createLocalAdmin, findE2eUser } from './environment';
import { createBlankProject } from './helpers';

/** 固定千节点数据中的形状节点私有内容。 */
const SHAPE_DATA = {
  shape: 'rectangle',
  fill: '#EDE9FE',
  stroke: '#7C3AED',
  strokeWidth: 1,
  cornerRadius: 8,
  opacity: 1,
  rotation: 0,
};

test('100/500/1000 节点基线保持可交互且模型数据源不产生 N+1', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const projectId = await createBlankProject(page);
  const admin = createLocalAdmin();
  const user = await findE2eUser(admin);
  if (!user) throw new Error('E2E 用户不存在');

  const metrics: Array<Record<string, unknown>> = [];
  let inserted = 0;
  for (const target of [100, 500, 1_000]) {
    const rows = Array.from({ length: target - inserted }, (_, offset) => {
      const index = inserted + offset;
      return {
        project_id: projectId,
        type: 'shape',
        position_x: (index % 40) * 150,
        position_y: Math.floor(index / 40) * 110,
        width: 120,
        height: 80,
        rotation: 0,
        z_index: index,
        data: SHAPE_DATA,
        created_by: user.id,
      };
    });
    for (let start = 0; start < rows.length; start += 250) {
      const { error } = await admin.from('canvas_nodes').insert(rows.slice(start, start + 250));
      if (error) throw error;
    }
    inserted = target;

    let modelRequests = 0;
    let credentialRequests = 0;
    const countRequest = (request: { url(): string }) => {
      const url = request.url();
      if (url.includes('/rest/v1/model_catalog')) modelRequests += 1;
      if (url.includes('/rest/v1/provider_credentials')) credentialRequests += 1;
    };
    page.on('request', countRequest);
    const startedAt = Date.now();
    await page.reload();
    await expect(page.locator('.react-flow__node-shape').first()).toBeVisible({ timeout: 20_000 });
    const interactiveMs = Date.now() - startedAt;
    const browser = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      heap:
        'memory' in performance
          ? (performance as Performance & { memory: { usedJSHeapSize: number } }).memory
              .usedJSHeapSize
          : null,
    }));
    page.off('request', countRequest);

    expect(interactiveMs).toBeLessThan(20_000);
    expect(modelRequests).toBeLessThanOrEqual(1);
    expect(credentialRequests).toBeLessThanOrEqual(1);
    metrics.push({ target, interactiveMs, modelRequests, credentialRequests, ...browser });
  }

  await testInfo.attach('performance-baseline.json', {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json',
  });
});
