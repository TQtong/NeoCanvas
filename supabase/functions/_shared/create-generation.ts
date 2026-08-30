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
  type GenerationSubmissionResult,
  type ModelCatalogRow,
  type SubmitGenerationResponse,
  type UnifiedGenerationRequest,
} from './types.ts';
import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';
import { validateParams } from './pipeline.ts';
import { moderatePromptText } from './moderation.ts';
import { triggerFunction } from './trigger.ts';
import { requireAccessibleModel } from './models.ts';
import { generationRequestHash } from './request-hash.ts';
import { resolveProviderAdapter } from './credentials.ts';
import { getAdapter } from './adapters/registry.ts';

/** 单项目在途生成数上限（防单项目刷量）。 */
const MAX_INFLIGHT = Number(Deno.env.get('MAX_INFLIGHT_GENERATIONS') ?? '8');

/** 按用户限流窗口（秒）与窗口内上限。 */
const RATE_WINDOW_SECS = Number(Deno.env.get('RATE_LIMIT_WINDOW_SECS') ?? '60');
const RATE_MAX = Number(Deno.env.get('RATE_LIMIT_MAX') ?? '30');

/** 将数据库 RPC 的稳定异常标识映射为能力面错误码。 */
function submissionError(error: { message: string }): ApiException {
  const message = error.message;
  if (message.includes('IDEMPOTENCY_CONFLICT')) {
    return new ApiException('idempotency_conflict', '同一幂等键已用于不同的生成请求');
  }
  if (message.includes('PROJECT_FORBIDDEN')) {
    return new ApiException('project_forbidden', '无权向该项目提交生成');
  }
  if (message.includes('PROJECT_NOT_FOUND')) {
    return new ApiException('not_found', '项目不存在');
  }
  if (
    message.includes('MODEL_NOT_ACCESSIBLE') || message.includes('MODEL_CREDENTIAL_UNAVAILABLE')
  ) {
    return new ApiException('model_not_accessible', '模型不可访问或 Provider 凭据不可用');
  }
  if (message.includes('GENERATION_INFLIGHT_LIMIT')) {
    return new ApiException('rate_limited', '在途生成任务过多，请稍后再试');
  }
  if (
    message.includes('CONVERSATION_NOT_IN_PROJECT') ||
    message.includes('MESSAGE_NOT_IN_CONVERSATION') ||
    message.includes('TARGET_NODE_NOT_ACCESSIBLE') ||
    message.includes('PLACEHOLDER_NODE_FORBIDDEN') ||
    message.includes('INVALID_')
  ) {
    return new ApiException('invalid_params', '生成请求关联的数据无效或不属于当前项目');
  }
  return new ApiException('internal_error', `创建生成任务失败：${message}`);
}

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

  const modelRow: ModelCatalogRow = await requireAccessibleModel(
    admin,
    request.modelKey,
    ownerId,
    request.modality,
  );

  // 引用资产越权校验（参考图 / 提及节点资产）
  await assertReferencesOwned(admin, request, ownerId);

  // 输入端内容审核（提示词）
  await moderatePromptText(admin, request.prompt);

  // 参数校验必须同时受模型目录与实际协议适配器约束，防止自定义模型虚报能力。
  const adapterProvider = await resolveProviderAdapter(
    admin,
    modelRow.provider,
    request.projectId,
  );
  const adapter = getAdapter(adapterProvider);
  validateParams(modelRow.capabilities, request, adapter.supportedOperations);

  // 精确幂等重试不重复消耗限流配额：最终是否可复用、摘要是否冲突仍由带项目行锁的
  // create_generation_submission 决定，此处只判断是否需要执行新增请求的滑动窗口检查。
  const { data: scopedExisting, error: existingError } = await admin
    .from('generations')
    .select('id')
    .eq('requester_id', ownerId)
    .eq('project_id', request.projectId)
    .eq('operation_type', 'generation')
    .eq('idempotency_key', request.idempotencyKey)
    .maybeSingle();
  if (existingError) {
    throw new ApiException('internal_error', `检查生成幂等作用域失败：${existingError.message}`);
  }
  if (!scopedExisting) {
    const { data: underRate, error: rateError } = await admin.rpc('check_user_generation_rate', {
      p_user_id: ownerId,
      p_window_secs: RATE_WINDOW_SECS,
      p_max: RATE_MAX,
    });
    if (rateError) {
      throw new ApiException('internal_error', `检查生成频率失败：${rateError.message}`);
    }
    if (underRate === false) {
      throw new ApiException('rate_limited', '操作过于频繁，请稍后再试');
    }
  }

  const generationId = crypto.randomUUID();
  const placeholderId = request.placeholderNodeId ?? crypto.randomUUID();
  const placement = request.placement ?? { x: 0, y: 0, width: 320, height: 320 };
  const digest = await generationRequestHash(request);
  const { data, error } = await admin.rpc('create_generation_submission', {
    p_requester_id: ownerId,
    p_generation_id: generationId,
    p_project_id: request.projectId,
    p_conversation_id: request.conversationId,
    p_message_id: request.messageId,
    p_modality: request.modality,
    p_model_key: request.modelKey,
    p_prompt: request.prompt,
    p_params: request.params,
    p_idempotency_key: request.idempotencyKey,
    p_request_hash: digest,
    p_placeholder_node_id: placeholderId,
    p_placement: placement,
    p_target_node_id: request.targetNodeId ?? null,
    p_result_mode: resultMode,
    p_operation_type: 'generation',
    p_max_inflight: MAX_INFLIGHT,
  });
  if (error) throw submissionError(error);

  const submission = data as GenerationSubmissionResult | null;
  if (!submission?.generationId || !submission.placeholderNodeId) {
    throw new ApiException('internal_error', '原子提交未返回完整的生成任务');
  }

  // 数据库提交完成后只做无状态的即时唤醒；即使唤醒失败，持久队列与 cron 仍会推进任务。
  triggerFunction('process-generation-queue', { generationId: submission.generationId });
  return {
    generationId: submission.generationId,
    placeholderNodeId: submission.placeholderNodeId,
    deduplicated: submission.reused,
    nodeIds: submission.nodeIds,
    edgeIds: submission.edgeIds,
    queueMessageId: submission.queueMessageId,
  };
}
