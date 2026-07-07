/**
 * 创建生成任务与占位节点的核心逻辑（第 06 篇 submit-generation 提交阶段）。
 *
 * 抽取为独立模块，供 submit-generation、create-project、agent-orchestrate 复用而不触发
 * 彼此的 `Deno.serve`（导入含 serve 的入口会启动其服务）。
 *
 * 提交阶段串联：幂等去重 → 模型校验 → 引用资产越权校验 → 输入端内容审核 → 按用户限流
 * 与按项目在途上限 → 建任务（pending）与占位节点 → 入队并唤起消费。
 *
 * @module functions/_shared/create-generation
 */

import {
  type ModelCatalogRow,
  type SubmitGenerationResponse,
  type UnifiedGenerationRequest,
} from './types.ts';
import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';
import { validateParams } from './pipeline.ts';
import { moderatePromptText } from './moderation.ts';
import { triggerFunction } from './trigger.ts';

/** 单项目在途生成数上限（防单项目刷量）。 */
const MAX_INFLIGHT = Number(Deno.env.get('MAX_INFLIGHT_GENERATIONS') ?? '8');

/** 按用户限流窗口（秒）与窗口内上限。 */
const RATE_WINDOW_SECS = Number(Deno.env.get('RATE_LIMIT_WINDOW_SECS') ?? '60');
const RATE_MAX = Number(Deno.env.get('RATE_LIMIT_MAX') ?? '30');

/** 媒体候选关系边类型与隐藏连接桩。 */
const MEDIA_CANDIDATE_EDGE_TYPE = 'media_candidate';
const MEDIA_CANDIDATE_HANDLE_OUT = 'media-candidate-out';
const MEDIA_CANDIDATE_HANDLE_IN = 'media-candidate-in';

/**
 * 校验请求中引用的资产是否归属当前用户，杜绝越权引用他人资产 / 提及节点。
 *
 * @param admin - 管理员客户端
 * @param request - 生成请求（含 params.references 及视频 params.keyframes）
 * @param ownerId - 当前用户
 * @throws {ApiException} forbidden 当存在不归属当前用户的引用资产
 */
async function assertReferencesOwned(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
  ownerId: string,
): Promise<void> {
  // 校验集合须覆盖请求 schema 支持的全部资产引用通道：无序参考 + 视频有序关键帧
  const materials = [...request.params.references];
  if (request.params.modality === 'video') {
    materials.push(...(request.params.keyframes ?? []));
  }
  const assetIds = Array.from(new Set(materials.map((r) => r.assetId)));
  if (assetIds.length === 0) return;
  const { data, error } = await admin
    .from('assets')
    .select('id')
    .eq('owner_id', ownerId)
    .in('id', assetIds);
  if (error) {
    throw new ApiException('internal_error', `校验引用资产失败：${error.message}`);
  }
  const owned = new Set((data ?? []).map((a) => a.id));
  const missing = assetIds.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    throw new ApiException('forbidden', '引用了不属于你的资产');
  }
}

/** 创建候选占位时写入专属候选关系边。 */
async function ensureCandidatePlaceholderEdge(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
  placeholderId: string,
  generationId: string,
): Promise<void> {
  if ((request.resultMode ?? 'new_primary') !== 'candidate_for_target' || !request.targetNodeId) {
    return;
  }
  const { data: existing, error: readError } = await admin
    .from('canvas_edges')
    .select('id')
    .eq('project_id', request.projectId)
    .eq('source_node_id', request.targetNodeId)
    .eq('target_node_id', placeholderId)
    .eq('type', MEDIA_CANDIDATE_EDGE_TYPE)
    .maybeSingle();
  if (readError) {
    throw new ApiException('internal_error', `读取候选关系边失败：${readError.message}`);
  }
  if (existing) return;

  const { error } = await admin.from('canvas_edges').insert({
    project_id: request.projectId,
    source_node_id: request.targetNodeId,
    target_node_id: placeholderId,
    source_handle: MEDIA_CANDIDATE_HANDLE_OUT,
    target_handle: MEDIA_CANDIDATE_HANDLE_IN,
    type: MEDIA_CANDIDATE_EDGE_TYPE,
    data: {
      label: '候选',
      generationId,
    },
  });
  if (error) {
    throw new ApiException('internal_error', `创建候选关系边失败：${error.message}`);
  }
}

/** 创建候选占位时同步创建其折叠媒体对话面板。 */
async function ensureCandidatePlaceholderPanel(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
  placeholderId: string,
  ownerId: string,
): Promise<void> {
  if ((request.resultMode ?? 'new_primary') !== 'candidate_for_target') return;
  const placement = request.placement ?? { x: 0, y: 0, width: 320, height: 320 };
  const { data: existing, error: readError } = await admin
    .from('canvas_nodes')
    .select('id')
    .eq('project_id', request.projectId)
    .eq('type', 'media_panel')
    .eq('data->>targetNodeId', placeholderId)
    .maybeSingle();
  if (readError) {
    throw new ApiException('internal_error', `读取候选媒体对话失败：${readError.message}`);
  }
  if (existing) return;

  const { error } = await admin.from('canvas_nodes').insert({
    project_id: request.projectId,
    type: 'media_panel',
    position_x: placement.x,
    position_y: placement.y + placement.height + 24,
    width: placement.width,
    height: 56,
    rotation: 0,
    z_index: 1,
    data: {
      targetNodeId: placeholderId,
      collapsed: true,
    },
    created_by: ownerId,
  });
  if (error) {
    throw new ApiException('internal_error', `创建候选媒体对话失败：${error.message}`);
  }
}

/**
 * 创建一条 pending 生成任务与其占位节点，并入队 + 唤起消费。
 *
 * @param admin - 管理员客户端（服务角色）
 * @param request - 统一生成请求
 * @param ownerId - 项目归属用户（占位节点 created_by）
 * @returns 任务与占位节点标识及是否幂等命中
 */
export async function createGeneration(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
  ownerId: string,
): Promise<SubmitGenerationResponse> {
  const resultMode = request.resultMode ?? 'new_primary';
  if (resultMode === 'candidate_for_target' && !request.targetNodeId) {
    throw new ApiException('invalid_params', '候选生成缺少目标媒体节点');
  }

  // 幂等：同一幂等键复用既有任务
  if (request.idempotencyKey) {
    const { data: existing } = await admin
      .from('generations')
      .select('id, placeholder_node_id')
      .eq('idempotency_key', request.idempotencyKey)
      .maybeSingle();
    if (existing) {
      return {
        generationId: existing.id,
        placeholderNodeId: existing.placeholder_node_id ?? '',
        deduplicated: true,
      };
    }
  }

  // 取模型并校验：限「内置模型」或「本人自有模型」（key 全局唯一，故至多一行命中）。
  // 防止引用他人私有模型；自有未上架的模型也在此被 is_active 拦下。
  const { data: model } = await admin
    .from('model_catalog')
    .select('*')
    .eq('key', request.modelKey)
    .or(`user_id.is.null,user_id.eq.${ownerId}`)
    .maybeSingle();
  if (!model || !(model as ModelCatalogRow).is_active) {
    throw new ApiException('model_unavailable', '模型不可用或已下架');
  }
  const modelRow = model as ModelCatalogRow;

  // 引用资产越权校验（参考图 / 提及节点资产）
  await assertReferencesOwned(admin, request, ownerId);

  // 输入端内容审核（提示词）
  await moderatePromptText(admin, request.prompt);

  // 参数校验 / 降级
  validateParams(modelRow.capabilities, request);

  // 按用户限流（滑动窗口）
  const { data: underRate } = await admin.rpc('check_user_generation_rate', {
    p_user_id: ownerId,
    p_window_secs: RATE_WINDOW_SECS,
    p_max: RATE_MAX,
  });
  if (underRate === false) {
    throw new ApiException('rate_limited', '操作过于频繁，请稍后再试');
  }

  // 按项目在途上限
  const { count } = await admin
    .from('generations')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', request.projectId)
    .in('status', ['pending', 'running']);
  if ((count ?? 0) >= MAX_INFLIGHT) {
    throw new ApiException('rate_limited', '在途生成任务过多，请稍后再试');
  }

  // 建任务（pending）；输入审核已通过，moderation_status 置 passed
  const generationId = crypto.randomUUID();
  const { error: genError } = await admin.from('generations').insert({
    id: generationId,
    project_id: request.projectId,
    conversation_id: request.conversationId,
    message_id: request.messageId,
    modality: request.modality,
    model_key: request.modelKey,
    provider: modelRow.provider,
    prompt: request.prompt,
    params: request.params,
    target_node_id: request.targetNodeId ?? null,
    result_mode: resultMode,
    status: 'pending',
    progress: 0,
    moderation_status: 'passed',
    idempotency_key: request.idempotencyKey,
  });
  if (genError) {
    // 唯一约束命中（并发同幂等键）→ 复用
    if (genError.code === '23505' && request.idempotencyKey) {
      const { data: existing } = await admin
        .from('generations')
        .select('id, placeholder_node_id')
        .eq('idempotency_key', request.idempotencyKey)
        .maybeSingle();
      if (existing) {
        return {
          generationId: existing.id,
          placeholderNodeId: existing.placeholder_node_id ?? '',
          deduplicated: true,
        };
      }
    }
    throw new ApiException('internal_error', `创建生成任务失败：${genError.message}`);
  }

  // 建占位节点（客户端可预创建 id 以即时可见；否则服务端生成）
  const placeholderId = request.placeholderNodeId ?? crypto.randomUUID();
  const placement = request.placement ?? { x: 0, y: 0, width: 320, height: 320 };
  const targetModality = request.modality === 'video' ? 'video' : 'image';

  // 原地重生成时，占位 id 指向一个已存在的真实节点：保留其 groupId 与 parent_id，使重生成结果
  // 仍属同一逻辑组、不脱离原画板（landResult / 本 upsert 会整体替换 data，不保留则脱组 / 脱离画板）。
  // 新占位（节点尚不存在）时读不到、为 undefined / null。
  const { data: existingNode } = await admin
    .from('canvas_nodes')
    .select('data, parent_id')
    .eq('id', placeholderId)
    .maybeSingle();
  const existingData =
    existingNode && existingNode.data && typeof existingNode.data === 'object'
      ? (existingNode.data as Record<string, unknown>)
      : null;
  const existingGroupId = existingData?.groupId;
  const existingMediaDescription = existingData?.mediaDescription;
  const existingGenerationSettings = existingData?.generationSettings;

  const { error: nodeError } = await admin.from('canvas_nodes').upsert(
    {
      id: placeholderId,
      project_id: request.projectId,
      type: 'generation_placeholder',
      position_x: placement.x,
      position_y: placement.y,
      width: placement.width,
      height: placement.height,
      rotation: 0,
      z_index: 0,
      parent_id: placement.parentId ?? existingNode?.parent_id ?? null,
      data: {
        targetModality,
        promptSummary: request.prompt.slice(0, 80),
        targetWidth: placement.width,
        targetHeight: placement.height,
        ...(request.targetNodeId ? { targetNodeId: request.targetNodeId } : {}),
        resultMode,
        ...(typeof existingGroupId === 'string' ? { groupId: existingGroupId } : {}),
        ...(typeof existingMediaDescription === 'string'
          ? { mediaDescription: existingMediaDescription }
          : {}),
        ...(existingGenerationSettings &&
        typeof existingGenerationSettings === 'object' &&
        !Array.isArray(existingGenerationSettings)
          ? { generationSettings: existingGenerationSettings }
          : {}),
      },
      generation_id: generationId,
      created_by: ownerId,
    },
    { onConflict: 'id' },
  );
  if (nodeError) {
    throw new ApiException('internal_error', `创建占位节点失败：${nodeError.message}`);
  }
  await ensureCandidatePlaceholderEdge(admin, request, placeholderId, generationId);
  await ensureCandidatePlaceholderPanel(admin, request, placeholderId, ownerId);

  // 关联占位节点
  await admin
    .from('generations')
    .update({ placeholder_node_id: placeholderId })
    .eq('id', generationId);

  // 入队 + 唤起消费
  await admin.rpc('enqueue_generation_job', { p_generation_id: generationId });
  triggerFunction('process-generation-queue', { generationId });

  return { generationId, placeholderNodeId: placeholderId, deduplicated: false };
}
