import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { createLocalAdmin, findE2eUser } from './environment';
import { createGeneratedProject } from './helpers';

/** 数据库中的最小图片节点视图。 */
interface ImageNodeRow {
  id: string;
  asset_id: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  data: Record<string, unknown>;
}

/** 创建确定性 320×320 源图并返回保持不变的主节点。 */
async function createPrecisionSource(page: Page): Promise<{
  projectId: string;
  primary: ImageNodeRow;
}> {
  const projectId = await createGeneratedProject(page, `精准编辑源图 ${crypto.randomUUID()}`);
  await expect(page.locator('.react-flow__node-image')).toHaveCount(1, { timeout: 30_000 });
  const admin = createLocalAdmin();
  const { data, error } = await admin
    .from('canvas_nodes')
    .select('id,asset_id,position_x,position_y,width,height,data')
    .eq('project_id', projectId)
    .eq('type', 'image')
    .single();
  if (error || !data) throw error ?? new Error('无法读取精准编辑源节点');
  return { projectId, primary: data as ImageNodeRow };
}

/** 选择图片节点并打开画布内精准编辑器。 */
async function openEditor(page: Page, nodeId: string): Promise<Locator> {
  const node = page.locator(`.react-flow__node-image[data-id="${nodeId}"]`);
  // 精准编辑必须拿到可解码的签名源图；先等待媒体投影就绪，失败时能直接定位 Storage 链路。
  await expect(node.locator('img').last()).toHaveAttribute('src', /\S+/, { timeout: 30_000 });
  // 首页提交沿用会话视口；先适应画布，确保节点上方的完整工具栏进入键鼠可达区域。
  await page.getByRole('button', { name: '适应画布' }).last().click();
  await node.click();
  await page.getByRole('button', { name: 'AI 精准编辑' }).click();
  const dialog = page.getByRole('dialog', { name: '精准编辑工作室' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 等待指定主节点的候选全部经 Realtime 落到画布与数据库。 */
async function waitForCandidates(
  page: Page,
  projectId: string,
  primaryNodeId: string,
  count: number,
): Promise<ImageNodeRow[]> {
  const admin = createLocalAdmin();
  await expect
    .poll(
      async () => {
        const { count: candidateCount } = await admin
          .from('canvas_nodes')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', projectId)
          .eq('data->>candidateOf', primaryNodeId);
        return candidateCount;
      },
      { timeout: 30_000 },
    )
    .toBe(count);
  await expect(page.locator('.react-flow__node-generation_placeholder')).toHaveCount(0, {
    timeout: 20_000,
  });
  // 候选默认折叠以保护原画布布局；验收候选交互前通过主节点工具栏显式展开。
  await page.locator(`.react-flow__node-image[data-id="${primaryNodeId}"]`).click();
  const expandCandidates = page.getByRole('button', { name: '展开候选' });
  if (await expandCandidates.isVisible()) await expandCandidates.click();
  // React Flow 只挂载可视节点；展开后再次适应画布，让所有候选真正进入 DOM。
  await page.getByRole('button', { name: '适应画布' }).last().click();
  await expect(page.locator('.react-flow__node-image')).toHaveCount(count + 1, {
    timeout: 20_000,
  });
  const { data, error } = await admin
    .from('canvas_nodes')
    .select('id,asset_id,position_x,position_y,width,height,data')
    .eq('project_id', projectId)
    .eq('data->>candidateOf', primaryNodeId);
  if (error) throw error;
  return ((data ?? []) as ImageNodeRow[]).sort(
    (left, right) => Number(left.data.candidateIndex) - Number(right.data.candidateIndex),
  );
}

/** 点击候选工具栏中的采用按钮。 */
async function adoptCandidate(page: Page, candidateId: string): Promise<void> {
  await page.locator(`.react-flow__node-image[data-id="${candidateId}"]`).click();
  await page.getByRole('button', { name: '替换主媒体' }).click();
}

test.describe('精准编辑工作室完整链路', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('语义编辑生成两个非破坏候选并采用第二候选', async ({ page }) => {
    const { projectId, primary } = await createPrecisionSource(page);
    const dialog = await openEditor(page, primary.id);
    await dialog.getByLabel('编辑提示词').fill('把背景改成深蓝色，主体保持不变');
    await dialog.getByLabel('候选数量').fill('2');
    await dialog.getByRole('button', { name: '生成候选' }).click();
    await expect(dialog).toBeHidden();

    const admin = createLocalAdmin();
    const candidates = await waitForCandidates(page, projectId, primary.id, 2);
    const { data: untouched } = await admin
      .from('canvas_nodes')
      .select('asset_id')
      .eq('id', primary.id)
      .single();
    expect(untouched?.asset_id).toBe(primary.asset_id);

    const chosen = candidates[1]!;
    await adoptCandidate(page, chosen.id);
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('canvas_nodes')
          .select('asset_id')
          .eq('id', primary.id)
          .single();
        return data?.asset_id;
      })
      .toBe(chosen.asset_id);
    const { data: oldContentBranch } = await admin
      .from('canvas_nodes')
      .select('asset_id,data')
      .eq('id', chosen.id)
      .single();
    expect(oldContentBranch?.asset_id).toBe(primary.asset_id);
    expect((oldContentBranch?.data as Record<string, unknown>).candidateOf).toBe(primary.id);
  });

  test('局部重绘上传标准辅助蒙版并支持画笔、橡皮、羽化和撤销重做', async ({ page }) => {
    const { projectId, primary } = await createPrecisionSource(page);
    const dialog = await openEditor(page, primary.id);
    await dialog.getByRole('tab', { name: /局部重绘/ }).click();
    const canvas = dialog.getByLabel('蒙版绘制区域');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('蒙版画布没有可交互尺寸');

    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 8 });
    await page.mouse.up();
    await dialog.getByRole('button', { name: '橡皮 (E)' }).click();
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await dialog.getByRole('button', { name: '撤销蒙版' }).click();
    await dialog.getByRole('button', { name: '重做蒙版' }).click();
    await dialog.getByRole('button', { name: '撤销蒙版' }).click();
    await dialog.getByLabel(/蒙版羽化/).fill('24');
    await dialog.getByLabel('编辑提示词').fill('把蒙版区域改成金色纹理');
    await dialog.getByRole('button', { name: '生成候选' }).click();

    await waitForCandidates(page, projectId, primary.id, 1);
    const admin = createLocalAdmin();
    const { data: generation, error: generationError } = await admin
      .from('generations')
      .select('id,params')
      .eq('project_id', projectId)
      .eq('operation_type', 'image:inpaint')
      .single();
    if (generationError || !generation) throw generationError ?? new Error('局部重绘任务不存在');
    expect((generation.params as Record<string, unknown>).maskFeatherPx).toBe(24);
    const { data: maskInput, error: inputError } = await admin
      .from('generation_inputs')
      .select('asset_id,role')
      .eq('generation_id', generation.id)
      .eq('role', 'mask')
      .single();
    if (inputError || !maskInput) throw inputError ?? new Error('蒙版输入血缘不存在');
    const { data: maskAsset, error: maskError } = await admin
      .from('assets')
      .select('is_auxiliary,width,height,mime_type,storage_bucket,storage_path')
      .eq('id', maskInput.asset_id)
      .single();
    if (maskError || !maskAsset) throw maskError ?? new Error('蒙版辅助资产不存在');
    expect(maskAsset).toMatchObject({
      is_auxiliary: true,
      width: 320,
      height: 320,
      mime_type: 'image/png',
    });
    const { data: maskBlob, error: downloadError } = await admin.storage
      .from(maskAsset.storage_bucket)
      .download(maskAsset.storage_path);
    if (downloadError || !maskBlob) throw downloadError ?? new Error('蒙版对象不存在');
    const metadata = await sharp(Buffer.from(await maskBlob.arrayBuffer())).metadata();
    expect(metadata).toMatchObject({ width: 320, height: 320, format: 'png', hasAlpha: true });
    const stats = await sharp(Buffer.from(await maskBlob.arrayBuffer())).stats();
    // 标准蒙版自身完全不透明；OpenAI Alpha 转换只发生在 Provider 边界。
    expect(stats.channels[3]?.min).toBe(255);
  });

  test('扩图候选位于分支槽位，采用后保持中心并交换新旧几何', async ({ page }) => {
    const { projectId, primary } = await createPrecisionSource(page);
    const dialog = await openEditor(page, primary.id);
    await dialog.getByRole('tab', { name: /扩图/ }).click();
    const rightHandle = dialog.getByRole('button', { name: '拖动扩展右边界' });
    const rightBox = await rightHandle.boundingBox();
    if (!rightBox) throw new Error('扩图右边手柄不可见');
    await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rightBox.x + rightBox.width / 2 + 80, rightBox.y + rightBox.height / 2);
    await page.mouse.up();
    await dialog.getByRole('button', { name: '16:9', exact: true }).click();
    await dialog.getByLabel('编辑提示词').fill('向两侧延展城市夜景');
    await dialog.getByRole('button', { name: '生成候选' }).click();

    const [candidate] = await waitForCandidates(page, projectId, primary.id, 1);
    expect(candidate).toBeDefined();
    expect(candidate!.position_x).toBeGreaterThan(primary.position_x + primary.width);
    expect(candidate!.width / candidate!.height).toBeCloseTo(16 / 9, 2);

    const oldCenter = {
      x: primary.position_x + primary.width / 2,
      y: primary.position_y + primary.height / 2,
    };
    await adoptCandidate(page, candidate!.id);
    const admin = createLocalAdmin();
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('canvas_nodes')
          .select('asset_id')
          .eq('id', primary.id)
          .single();
        return data?.asset_id;
      })
      .toBe(candidate!.asset_id);
    const { data: adopted } = await admin
      .from('canvas_nodes')
      .select('position_x,position_y,width,height')
      .eq('id', primary.id)
      .single();
    expect((adopted!.position_x as number) + (adopted!.width as number) / 2).toBeCloseTo(
      oldCenter.x,
      4,
    );
    expect((adopted!.position_y as number) + (adopted!.height as number) / 2).toBeCloseTo(
      oldCenter.y,
      4,
    );
    expect((adopted!.width as number) / (adopted!.height as number)).toBeCloseTo(16 / 9, 2);
    const { data: oldBranch } = await admin
      .from('canvas_nodes')
      .select('width,height,asset_id')
      .eq('id', candidate!.id)
      .single();
    expect(oldBranch).toMatchObject({
      width: primary.width,
      height: primary.height,
      asset_id: primary.asset_id,
    });
  });

  test('去背景输出真实 Alpha 棋盘格，2×/4× 放大只改变自然尺寸', async ({ page }) => {
    test.setTimeout(120_000);
    const admin = createLocalAdmin();

    const removeSource = await createPrecisionSource(page);
    let dialog = await openEditor(page, removeSource.primary.id);
    await dialog.getByRole('tab', { name: /去背景/ }).click();
    await dialog.getByRole('button', { name: '生成候选' }).click();
    const [transparentCandidate] = await waitForCandidates(
      page,
      removeSource.projectId,
      removeSource.primary.id,
      1,
    );
    const { data: transparentAsset } = await admin
      .from('assets')
      .select('storage_bucket,storage_path')
      .eq('id', transparentCandidate!.asset_id)
      .single();
    const { data: transparentBlob, error: transparentError } = await admin.storage
      .from(transparentAsset!.storage_bucket)
      .download(transparentAsset!.storage_path);
    if (transparentError || !transparentBlob) throw transparentError;
    const transparentBuffer = Buffer.from(await transparentBlob.arrayBuffer());
    const transparentMetadata = await sharp(transparentBuffer).metadata();
    const transparentStats = await sharp(transparentBuffer).stats();
    expect(transparentMetadata.hasAlpha).toBe(true);
    expect(transparentStats.channels[3]!.min).toBeLessThan(255);
    const grid = page
      .locator(`.react-flow__node-image[data-id="${transparentCandidate!.id}"]`)
      .getByTestId('image-transparency-grid');
    await expect(grid).toHaveCSS('background-image', /linear-gradient/);
    await adoptCandidate(page, transparentCandidate!.id);
    const { data: removeFrame } = await admin
      .from('canvas_nodes')
      .select('width,height')
      .eq('id', removeSource.primary.id)
      .single();
    expect(removeFrame).toMatchObject({
      width: removeSource.primary.width,
      height: removeSource.primary.height,
    });

    for (const factor of [2, 4] as const) {
      const source = await createPrecisionSource(page);
      dialog = await openEditor(page, source.primary.id);
      await dialog.getByRole('tab', { name: /高清放大/ }).click();
      await dialog.getByRole('button', { name: `${factor}×`, exact: true }).click();
      await dialog.getByRole('button', { name: '生成候选' }).click();
      const [candidate] = await waitForCandidates(page, source.projectId, source.primary.id, 1);
      const { data: asset } = await admin
        .from('assets')
        .select('width,height')
        .eq('id', candidate!.asset_id)
        .single();
      expect(asset).toMatchObject({ width: 320 * factor, height: 320 * factor });
      await adoptCandidate(page, candidate!.id);
      await expect
        .poll(async () => {
          const { data } = await admin
            .from('canvas_nodes')
            .select('data')
            .eq('id', source.primary.id)
            .single();
          return (data?.data as Record<string, unknown> | undefined)?.naturalWidth;
        })
        .toBe(320 * factor);
      const { data: node } = await admin
        .from('canvas_nodes')
        .select('width,height,data')
        .eq('id', source.primary.id)
        .single();
      expect(node).toMatchObject({ width: source.primary.width, height: source.primary.height });
      expect((node!.data as Record<string, unknown>).naturalWidth).toBe(320 * factor);
      expect((node!.data as Record<string, unknown>).naturalHeight).toBe(320 * factor);
    }
  });

  test('合并当前外观创建辅助输入，失败保留会话且 Realtime 更新/删除安全关闭提交', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { projectId, primary } = await createPrecisionSource(page);
    const admin = createLocalAdmin();
    const user = await findE2eUser(admin);
    if (!user) throw new Error('E2E 用户不存在');
    const { data: currentNode } = await admin
      .from('canvas_nodes')
      .select('data')
      .eq('id', primary.id)
      .single();
    await admin
      .from('canvas_nodes')
      .update({
        data: {
          ...(currentNode!.data as Record<string, unknown>),
          groupId: 'precision-flatten-group',
          filters: {
            brightness: 1.1,
            contrast: 1,
            saturation: 1,
            grayscale: 0,
            sepia: 0,
            blur: 0,
            hueRotate: 0,
          },
        },
      })
      .eq('id', primary.id);
    await admin.from('canvas_nodes').insert([
      {
        project_id: projectId,
        type: 'text',
        position_x: primary.position_x + 20,
        position_y: primary.position_y + 20,
        width: 180,
        height: 50,
        z_index: 20,
        created_by: user.id,
        data: {
          text: '同组叠加文字',
          groupId: 'precision-flatten-group',
          fontSize: 24,
          fontFamily: 'sans-serif',
          fontWeight: 700,
          fontStyle: 'normal',
          color: '#ffffff',
          textAlign: 'left',
          lineHeight: 1.2,
          letterSpacing: 0,
          opacity: 1,
          rotation: 0,
          backgroundColor: 'transparent',
          verticalAlign: 'top',
        },
      },
      {
        project_id: projectId,
        type: 'text',
        position_x: primary.position_x + 20,
        position_y: primary.position_y + 100,
        width: 180,
        height: 50,
        z_index: 21,
        created_by: user.id,
        data: {
          text: '组外不应合并',
          groupId: 'another-group',
          fontSize: 24,
          fontFamily: 'sans-serif',
          fontWeight: 700,
          fontStyle: 'normal',
          color: '#ff0000',
          textAlign: 'left',
          lineHeight: 1.2,
          letterSpacing: 0,
          opacity: 1,
          rotation: 0,
          backgroundColor: 'transparent',
          verticalAlign: 'top',
        },
      },
    ]);
    await page.reload();
    let dialog = await openEditor(page, primary.id);
    await dialog.getByLabel('输入来源').selectOption('flattened');
    await expect(dialog.getByRole('status', { name: '正在合并当前外观' })).toBeHidden({
      timeout: 20_000,
    });
    await expect(dialog.getByText('输入 320 × 320px')).toBeVisible();
    await dialog.getByLabel('编辑提示词').fill('提高整体对比度');
    await dialog.getByRole('button', { name: '生成候选' }).click();
    await waitForCandidates(page, projectId, primary.id, 1);
    const { data: flattenedGeneration } = await admin
      .from('generations')
      .select('id,params')
      .eq('project_id', projectId)
      .eq('operation_type', 'image:semantic_edit')
      .single();
    expect((flattenedGeneration!.params as Record<string, unknown>).inputMode).toBe('flattened');
    const { data: flattenedInput } = await admin
      .from('generation_inputs')
      .select('asset_id')
      .eq('generation_id', flattenedGeneration!.id)
      .eq('role', 'content')
      .single();
    const { data: flattenedAsset } = await admin
      .from('assets')
      .select('is_auxiliary,width,height')
      .eq('id', flattenedInput!.asset_id)
      .single();
    expect(flattenedAsset).toMatchObject({ is_auxiliary: true, width: 320, height: 320 });

    const failureSource = await createPrecisionSource(page);
    dialog = await openEditor(page, failureSource.primary.id);
    await dialog.getByRole('tab', { name: /局部重绘/ }).click();
    const mask = dialog.getByLabel('蒙版绘制区域');
    await mask.focus();
    await mask.press('Space');
    await dialog.getByLabel('编辑提示词').fill('上传失败后保留这些参数');
    await page.route('**/storage/v1/object/uploads/**', (route) => route.abort());
    await dialog.getByRole('button', { name: '生成候选' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('编辑提示词')).toHaveValue('上传失败后保留这些参数');
    await page.unroute('**/storage/v1/object/uploads/**');

    await admin
      .from('canvas_nodes')
      .update({ width: failureSource.primary.width + 10 })
      .eq('id', failureSource.primary.id);
    await expect(dialog.getByText(/画布内容已在其他位置更新/)).toBeVisible({ timeout: 20_000 });
    await admin.from('canvas_nodes').delete().eq('id', failureSource.primary.id);
    await expect(dialog.getByText(/目标图片已在其他位置删除/)).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button', { name: '生成候选' })).toBeDisabled();
  });

  test('无 Provider 有明确配置入口，键盘绘制/撤销/提交并在退出后恢复焦点', async ({ page }) => {
    const { primary } = await createPrecisionSource(page);
    const admin = createLocalAdmin();
    const { error: disableError } = await admin
      .from('provider_credentials')
      .update({ enabled: false })
      .eq('provider', 'custom:neocanvas-test');
    if (disableError) throw disableError;
    try {
      await page.reload();
      let dialog = await openEditor(page, primary.id);
      await expect(dialog.getByText(/当前操作没有同时满足 Provider/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: '配置模型提供商' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '生成候选' })).toBeDisabled();
      await dialog.getByRole('button', { name: '取消' }).click();

      await admin
        .from('provider_credentials')
        .update({ enabled: true })
        .eq('provider', 'custom:neocanvas-test');
      await page.reload();
      dialog = await openEditor(page, primary.id);
      await dialog.getByRole('tab', { name: /局部重绘/ }).focus();
      await page.keyboard.press('Enter');
      const mask = dialog.getByLabel('蒙版绘制区域');
      await mask.focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Space');
      const prompt = dialog.getByLabel('编辑提示词');
      await prompt.fill('键盘提交局部重绘');
      await prompt.press('Control+Enter');
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'AI 精准编辑' })).toBeFocused();
    } finally {
      await admin
        .from('provider_credentials')
        .update({ enabled: true })
        .eq('provider', 'custom:neocanvas-test');
    }
  });
});
