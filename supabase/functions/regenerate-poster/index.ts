/**
 * 整组海报重新编排（regenerate-poster）。
 *
 * 「成组海报」= 一张背景图节点 + 若干同 `groupId` 的可编辑文字节点。本函数以该组为参考整组
 * 重生成、并原地替换（第 05 篇第七节海报合成扩展）：
 *
 *   1. 取该组成员，定位背景图节点与文字节点；
 *   2. 由现有文字重建「主题/文案」brief，连同项目场景交海报编排 LLM 产出新版式
 *      （新背景提示词 + 新文字元素）；
 *   3. 背景以「图生图」原地重生成——参考原背景图，占位 id = 背景节点自身（landResult 落回时
 *      经管线保留 groupId，故背景仍属同一组）；
 *   4. 删除旧文字节点，按新版式建「新的可编辑文字节点」，沿用同一 groupId，使整组保持成组。
 *
 * 文字仍是独立可编辑节点（中文清晰，不被烤进图里）；文案与排版会更新（用户所选行为）。
 *
 * @module functions/regenerate-poster
 */

import {
  type ModelCatalogRow,
  type ReferenceMaterial,
  type RegeneratePosterRequest,
  type RegeneratePosterResponse,
  type Scene,
  type UnifiedGenerationRequest,
} from '../_shared/types.ts';
import { ApiException, exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';
import { buildGenerationParams } from '../_shared/params.ts';
import {
  buildPosterLayout,
  buildPosterTextNodeRows,
  POSTER_ASPECT_RATIO,
  POSTER_HEIGHT,
  POSTER_WIDTH,
} from '../_shared/poster.ts';
import { createGeneration } from '../_shared/create-generation.ts';

/** 画布节点行（本函数读取所需字段）。 */
interface CanvasNodeRow {
  id: string;
  type: string;
  position_x: number;
  position_y: number;
  width: number | null;
  height: number | null;
  asset_id: string | null;
  parent_id: string | null;
  z_index: number | null;
  data: Record<string, unknown> | null;
}

/** 可作为海报叠层、随重排一并删除的节点类型（背景媒体除外）。 */
const OVERLAY_TYPES = new Set<string>(['text', 'shape', 'drawing']);

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  try {
    const { userId } = await requireUser(request);
    const admin = createAdminClient();
    const body = (await request.json()) as RegeneratePosterRequest;

    if (!body.projectId || !body.groupId || !body.backgroundNodeId || !body.modelKey) {
      throw new ApiException('invalid_params', '缺少必要字段');
    }
    await assertProjectOwner(admin, body.projectId, userId);

    // 1) 取该逻辑组全部成员
    const { data: groupNodes, error: groupErr } = await admin
      .from('canvas_nodes')
      .select('id, type, position_x, position_y, width, height, asset_id, parent_id, z_index, data')
      .eq('project_id', body.projectId)
      .eq('data->>groupId', body.groupId);
    if (groupErr) {
      throw new ApiException('internal_error', `读取组节点失败：${groupErr.message}`);
    }
    const members = (groupNodes ?? []) as CanvasNodeRow[];

    const bg = members.find((n) => n.id === body.backgroundNodeId);
    if (!bg || bg.type !== 'image' || !bg.asset_id) {
      throw new ApiException('invalid_params', '背景图节点无效或未绑定资产');
    }
    // 旧叠层 = 除背景外所有叠层类节点（文字 / 形状 / 手绘）；整组重排时一并删除，避免脱节残留。
    const overlayNodes = members.filter(
      (n) => n.id !== body.backgroundNodeId && OVERLAY_TYPES.has(n.type),
    );
    const textNodes = overlayNodes.filter((n) => n.type === 'text');

    // 2) 取模型（须为活跃图像模型）
    const { data: model } = await admin
      .from('model_catalog')
      .select('*')
      .eq('key', body.modelKey)
      .maybeSingle();
    const modelRow = model as ModelCatalogRow | null;
    if (!modelRow || !modelRow.is_active) {
      throw new ApiException('model_unavailable', '模型不可用或已下架');
    }
    if (modelRow.modality !== 'image') {
      throw new ApiException('invalid_params', '海报背景需图像模型');
    }

    // 3) 主题：由现有文字（按层级升序，近似从底到顶）拼出，作为编排 LLM 的文案参考
    const brief = textNodes
      .slice()
      .sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0))
      .map((n) => String(n.data?.text ?? '').trim())
      .filter(Boolean)
      .join('，');
    const content = brief || '海报';

    // 4) 项目场景
    const { data: project } = await admin
      .from('projects')
      .select('initial_scene')
      .eq('id', body.projectId)
      .maybeSingle();
    const scene = (project?.initial_scene as Scene | null) ?? null;

    // 5) 海报版式（新背景提示词 + 新文字元素）
    const layout = await buildPosterLayout(content, scene);

    // 6) 背景落位 = 背景节点当前框（原地）；保留其父画板，避免脱离画板
    const placement = {
      x: bg.position_x,
      y: bg.position_y,
      width: bg.width ?? POSTER_WIDTH,
      height: bg.height ?? POSTER_HEIGHT,
      parentId: bg.parent_id ?? null,
    };

    // 7) 先原子替换文字：删旧叠层（文字/形状/手绘）+ 建新文字节点（同 groupId）于单一事务。
    // 置于背景生成之前——文字一步原子完成，若失败则不会留下「已排队背景但文字半应用」的状态。
    const seedId = crypto.randomUUID();
    const textRows = buildPosterTextNodeRows(
      layout,
      placement,
      body.projectId,
      userId,
      seedId,
      body.groupId,
    );
    const { error: swapErr } = await admin.rpc('regenerate_poster_text_nodes', {
      p_delete_ids: overlayNodes.map((n) => n.id),
      p_rows: textRows,
    });
    if (swapErr) {
      throw new ApiException('internal_error', `海报文字重排失败：${swapErr.message}`);
    }
    const textNodeIds = textRows.map((r) => r.id);

    // 8) 背景图生图：参考原背景图，原地落在背景节点（placeholderNodeId = 背景节点 id）。
    // 输出比例按背景朝向取模型支持的比例，退回海报竖版比例。
    const portrait = (bg.height ?? 1) > (bg.width ?? 1);
    const desired = portrait ? '3:4' : '1:1';
    const supported = modelRow.capabilities.aspectRatios;
    const aspectRatio = supported.includes(desired)
      ? desired
      : (supported[0] ?? POSTER_ASPECT_RATIO);

    const references: ReferenceMaterial[] = [
      { origin: 'node', nodeId: bg.id, assetId: bg.asset_id, role: 'content' },
    ];
    const params = buildGenerationParams(
      'image',
      { ...modelRow.default_params, aspectRatio },
      references,
    );
    const genRequest: UnifiedGenerationRequest = {
      projectId: body.projectId,
      conversationId: body.conversationId,
      messageId: null,
      modality: 'image',
      modelKey: body.modelKey,
      prompt: layout.backgroundPrompt,
      params,
      idempotencyKey: crypto.randomUUID(),
      placement,
      placeholderNodeId: bg.id,
    };
    const gen = await createGeneration(admin, genRequest, userId);

    return ok<RegeneratePosterResponse>({
      generationId: gen.generationId,
      placeholderNodeId: gen.placeholderNodeId,
      textNodeIds,
      reply: layout.reply,
    });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
