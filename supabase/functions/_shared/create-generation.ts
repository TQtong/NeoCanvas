/**
 * 创建生成任务与占位节点的核心逻辑（第 06 篇 submit-generation 提交阶段）。
 *
 * 抽取为独立模块，供 submit-generation、create-project、agent-orchestrate 复用而不触发
 * 彼此的 `Deno.serve`（导入含 serve 的入口会启动其服务）。
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
import { moderatePrompt, validateParams } from './pipeline.ts';
import { triggerFunction } from './trigger.ts';

/** 单用户在途生成数上限（防刷量）。 */
const MAX_INFLIGHT = Number(Deno.env.get('MAX_INFLIGHT_GENERATIONS') ?? '8');

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

  // 取模型并校验
  const { data: model } = await admin
    .from('model_catalog')
    .select('*')
    .eq('key', request.modelKey)
    .maybeSingle();
  if (!model || !(model as ModelCatalogRow).is_active) {
    throw new ApiException('model_unavailable', '模型不可用或已下架');
  }
  const modelRow = model as ModelCatalogRow;
  moderatePrompt(request.prompt);
  validateParams(modelRow.capabilities, request);

  // 在途上限
  const { count } = await admin
    .from('generations')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', request.projectId)
    .in('status', ['pending', 'running']);
  if ((count ?? 0) >= MAX_INFLIGHT) {
    throw new ApiException('rate_limited', '在途生成任务过多，请稍后再试');
  }

  // 建任务（pending）
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
    status: 'pending',
    progress: 0,
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
      parent_id: placement.parentId ?? null,
      data: {
        targetModality,
        promptSummary: request.prompt.slice(0, 80),
        targetWidth: placement.width,
        targetHeight: placement.height,
      },
      generation_id: generationId,
      created_by: ownerId,
    },
    { onConflict: 'id' },
  );
  if (nodeError) {
    throw new ApiException('internal_error', `创建占位节点失败：${nodeError.message}`);
  }

  // 关联占位节点
  await admin.from('generations').update({ placeholder_node_id: placeholderId }).eq('id', generationId);

  // 入队 + 唤起消费
  await admin.rpc('enqueue_generation_job', { p_generation_id: generationId });
  triggerFunction('process-generation-queue', { generationId });

  return { generationId, placeholderNodeId: placeholderId, deduplicated: false };
}
