import { expect, test } from '@playwright/test';
import { E2E_MODEL_KEY, createLocalAdmin, findE2eUser } from './environment';
import { createBlankProject } from './helpers';

test.describe('Flow Studio 核心旅程', () => {
  test('运行、Canvas 发布、Flow App 与 Agent 形成可复用闭环', async ({ page }) => {
    test.setTimeout(90_000);
    const projectId = await createBlankProject(page);
    const admin = createLocalAdmin();
    const user = await findE2eUser(admin);
    if (!user) throw new Error('E2E 用户不存在');

    const workflowId = crypto.randomUUID();
    const inputId = crypto.randomUUID();
    const outputId = crypto.randomUUID();
    const text = `Flow E2E 文本 ${crypto.randomUUID()}`;
    const { error: workflowError } = await admin.from('workflows').insert({
      id: workflowId,
      project_id: projectId,
      owner_id: user.id,
      name: 'Flow E2E 文本发布',
    });
    if (workflowError) throw workflowError;
    const { error: nodesError } = await admin.from('workflow_nodes').insert([
      {
        id: inputId,
        workflow_id: workflowId,
        kind: 'text_input',
        position_x: 80,
        position_y: 160,
        config: { value: text },
      },
      {
        id: outputId,
        workflow_id: workflowId,
        kind: 'text_output',
        position_x: 440,
        position_y: 160,
        config: {},
      },
    ]);
    if (nodesError) throw nodesError;
    const { error: edgeError } = await admin.from('workflow_edges').insert({
      workflow_id: workflowId,
      source_node_id: inputId,
      source_port: 'text',
      target_node_id: outputId,
      target_port: 'text',
      value_type: 'text',
    });
    if (edgeError) throw edgeError;

    await page.goto(`/p/${projectId}?view=flow&workflow=${workflowId}`);
    await expect(page.getByRole('button', { name: 'Flow', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('revision 3 · saved', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('button', { name: '运行全部', exact: true }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /succeeded/ }).first()).toBeVisible();

    const output = page.getByRole('button', { name: new RegExp(text) });
    await output.click();
    await page.getByRole('button', { name: '发布到 Canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(page.locator('.react-flow__node-text')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.react-flow__node-text')).toContainText(text);

    // 回到 Flow 再发布同一输出，来源绑定保证不会复制第二个 Canvas 节点。
    await page.getByRole('button', { name: 'Flow', exact: true }).click();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(text) }).click();
    await page.getByRole('button', { name: '发布到 Canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();

    const { count, error: countError } = await admin
      .from('canvas_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('type', 'text')
      .eq('data->>text', text);
    if (countError) throw countError;
    expect(count).toBe(1);

    // 发布不可变模板与项目内 App，再用表单创建 UUID 全量重映射的新实例并执行。
    await page.getByRole('button', { name: 'Flow', exact: true }).click();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('button', { name: '发布不可变模板版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '发布 Flow App', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '发布 Flow App', exact: true }).click();
    await page.getByRole('button', { name: 'Flow Apps', exact: true }).click();

    const launcher = page.getByRole('complementary', { name: 'Flow Apps' });
    await expect(
      launcher.getByText('Flow E2E 文本发布 App', { exact: true }).first(),
    ).toBeVisible();
    const appText = `Flow App E2E ${crypto.randomUUID()}`;
    await launcher
      .locator('label')
      .filter({ hasText: '文本输入 · value' })
      .locator('input')
      .fill(appText);
    await launcher.getByRole('button', { name: '运行 Flow App', exact: true }).click();
    await expect(launcher).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('workflow'), { timeout: 30_000 })
      .not.toBe(workflowId);
    const instantiatedWorkflowId = new URL(page.url()).searchParams.get('workflow');
    expect(instantiatedWorkflowId).toBeTruthy();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await expect(page.getByText(appText, { exact: true })).toBeVisible({ timeout: 60_000 });

    const { data: instanceNodes, error: instanceError } = await admin
      .from('workflow_nodes')
      .select('id')
      .eq('workflow_id', instantiatedWorkflowId!);
    if (instanceError) throw instanceError;
    expect(instanceNodes).toHaveLength(2);
    expect(new Set(instanceNodes?.map((node) => node.id))).not.toContain(inputId);
    expect(new Set(instanceNodes?.map((node) => node.id))).not.toContain(outputId);
    const { count: appCount, error: appCountError } = await admin
      .from('flow_apps')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId);
    if (appCountError) throw appCountError;
    expect(appCount).toBe(1);

    // Agent 只提交 Patch；确认应用新增注释但不自动运行，用户随后显式运行新修订。
    const { count: runsBeforeAgent } = await admin
      .from('workflow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', instantiatedWorkflowId!);
    expect(runsBeforeAgent).toBe(1);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page
      .getByPlaceholder('例如：增加四图生成、人工选择和 2× 放大流程')
      .fill('记录本次 Flow App 验收说明');
    await page.getByRole('button', { name: '生成差异提案', exact: true }).click();
    await expect(page.getByText('Patch 差异', { exact: true })).toBeVisible();
    await expect(page.getByText('pending', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认应用', exact: true }).click();
    await expect(page.getByText('applied', { exact: true })).toBeVisible();

    const { count: noteCount, error: noteError } = await admin
      .from('workflow_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', instantiatedWorkflowId!)
      .eq('kind', 'note');
    if (noteError) throw noteError;
    expect(noteCount).toBe(1);
    const { count: runsAfterAgent } = await admin
      .from('workflow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', instantiatedWorkflowId!);
    expect(runsAfterAgent).toBe(1);

    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('button', { name: '运行全部', exact: true }).click();
    await expect
      .poll(
        async () => {
          const { count } = await admin
            .from('workflow_runs')
            .select('id', { count: 'exact', head: true })
            .eq('workflow_id', instantiatedWorkflowId!);
          return count;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
  });

  test('四图生成、人工选择、放大、缓存与 Canvas 发布形成媒体闭环', async ({ page }) => {
    test.setTimeout(120_000);
    const projectId = await createBlankProject(page);
    const admin = createLocalAdmin();
    const user = await findE2eUser(admin);
    if (!user) throw new Error('E2E 用户不存在');

    const workflowId = crypto.randomUUID();
    const nodeIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    const inputId = nodeIds[0]!;
    const generateId = nodeIds[1]!;
    const selectId = nodeIds[2]!;
    const upscaleId = nodeIds[3]!;
    const outputId = nodeIds[4]!;
    const { error: workflowError } = await admin.from('workflows').insert({
      id: workflowId,
      project_id: projectId,
      owner_id: user.id,
      name: 'Flow E2E 媒体闭环',
    });
    if (workflowError) throw workflowError;
    const { error: nodesError } = await admin.from('workflow_nodes').insert([
      {
        id: inputId,
        workflow_id: workflowId,
        kind: 'text_input',
        position_x: 40,
        position_y: 160,
        config: { value: `四图候选 ${crypto.randomUUID()}` },
      },
      {
        id: generateId,
        workflow_id: workflowId,
        kind: 'image_generate',
        position_x: 340,
        position_y: 160,
        config: { modelKey: E2E_MODEL_KEY, count: 4, aspectRatio: '1:1', quality: 'auto' },
      },
      {
        id: selectId,
        workflow_id: workflowId,
        kind: 'image_select',
        position_x: 640,
        position_y: 160,
        config: { mode: 'manual', selectedIndex: 0 },
      },
      {
        id: upscaleId,
        workflow_id: workflowId,
        kind: 'image_upscale',
        position_x: 940,
        position_y: 160,
        config: {
          modelKey: E2E_MODEL_KEY,
          count: 1,
          aspectRatio: '1:1',
          quality: 'auto',
          inputMode: 'original',
          factor: 2,
        },
      },
      {
        id: outputId,
        workflow_id: workflowId,
        kind: 'image_output',
        position_x: 1240,
        position_y: 160,
        config: {},
      },
    ]);
    if (nodesError) throw nodesError;
    const { error: edgesError } = await admin.from('workflow_edges').insert([
      {
        workflow_id: workflowId,
        source_node_id: inputId,
        source_port: 'text',
        target_node_id: generateId,
        target_port: 'prompt',
        value_type: 'text',
      },
      {
        workflow_id: workflowId,
        source_node_id: generateId,
        source_port: 'images',
        target_node_id: selectId,
        target_port: 'images',
        value_type: 'image_list',
      },
      {
        workflow_id: workflowId,
        source_node_id: selectId,
        source_port: 'image',
        target_node_id: upscaleId,
        target_port: 'image',
        value_type: 'image_asset',
      },
      {
        workflow_id: workflowId,
        source_node_id: upscaleId,
        source_port: 'image',
        target_node_id: outputId,
        target_port: 'image',
        value_type: 'image_asset',
      },
    ]);
    if (edgesError) throw edgesError;

    await page.goto(`/p/${projectId}?view=flow&workflow=${workflowId}`);
    await expect(page.getByText('revision 9 · saved', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('button', { name: '运行全部', exact: true }).click();
    await expect(page.getByText('等待选择图片', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByAltText('候选')).toHaveCount(4);
    await page.getByAltText('候选').first().locator('..').click();
    await expect(page.getByRole('button', { name: /succeeded/ }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByAltText('运行输出')).toHaveCount(1);
    await page.getByAltText('运行输出').locator('..').click();
    await page.getByRole('button', { name: '发布到 Canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(page.locator('.react-flow__node-image')).toHaveCount(1, { timeout: 20_000 });

    const countGenerations = async () => {
      const { count, error } = await admin
        .from('generations')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('result_mode', 'workflow_output');
      if (error) throw error;
      return count;
    };
    expect(await countGenerations()).toBe(2);
    const { count: placeholderCount, error: placeholderError } = await admin
      .from('canvas_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('type', 'generation_placeholder');
    if (placeholderError) throw placeholderError;
    expect(placeholderCount).toBe(0);

    // 未变化的第二次运行复用两次模型产出，但人工选择仍然暂停并要求用户重新确认。
    await page.getByRole('button', { name: 'Flow', exact: true }).click();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('button', { name: '运行全部', exact: true }).click();
    await expect(page.getByText('等待选择图片', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(await countGenerations()).toBe(2);
    await page.getByAltText('候选').first().locator('..').click();
    await expect(page.getByRole('button', { name: /succeeded/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(await countGenerations()).toBe(2);
  });
});
