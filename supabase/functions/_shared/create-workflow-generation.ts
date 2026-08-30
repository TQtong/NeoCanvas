/** Flow 节点提交到既有生成队列的专用入口；不创建 Canvas 占位节点。 */

import {
  normalizeImageOperation,
  type ReferenceMaterial,
  type UnifiedGenerationRequest,
} from './types.ts';
import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';
import { requireAccessibleModel } from './models.ts';
import { resolveProviderAdapter } from './credentials.ts';
import { getAdapter } from './adapters/registry.ts';
import { validateParams } from './pipeline.ts';
import { moderatePromptText } from './moderation.ts';
import { generationRequestHash } from './request-hash.ts';
import { triggerFunction } from './trigger.ts';

const MAX_INFLIGHT = Number(Deno.env.get('MAX_INFLIGHT_GENERATIONS') ?? '8');
const RATE_WINDOW_SECS = Number(Deno.env.get('RATE_LIMIT_WINDOW_SECS') ?? '60');
const RATE_MAX = Number(Deno.env.get('RATE_LIMIT_MAX') ?? '30');

/** 工作流生成提交结果。 */
export interface WorkflowGenerationSubmission {
  generationId: string;
  reused: boolean;
}

function generationInputs(request: UnifiedGenerationRequest): Array<{
  assetId: string;
  role: ReferenceMaterial['role'];
  ordinal: number;
}> {
  const inputs = [...request.params.references];
  if (request.params.modality === 'video') inputs.push(...(request.params.keyframes ?? []));
  return inputs.map((input, ordinal) => ({ assetId: input.assetId, role: input.role, ordinal }));
}

/** 严格校验模型、参数、内容与限流后，原子写 generation + inputs + queue。 */
export async function createWorkflowGeneration(
  admin: SupabaseClient,
  runNodeId: string,
  request: UnifiedGenerationRequest,
  ownerId: string,
): Promise<WorkflowGenerationSubmission> {
  const model = await requireAccessibleModel(
    admin,
    request.modelKey,
    ownerId,
    request.modality,
  );
  await moderatePromptText(admin, request.prompt);
  const adapterProvider = await resolveProviderAdapter(admin, model.provider, request.projectId);
  validateParams(model.capabilities, request, getAdapter(adapterProvider).supportedOperations);

  const { count: inflight, error: inflightError } = await admin
    .from('generations')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', request.projectId)
    .in('status', ['pending', 'running']);
  if (inflightError) throw new ApiException('internal_error', inflightError.message);
  if ((inflight ?? 0) >= MAX_INFLIGHT) {
    throw new ApiException('rate_limited', '在途生成任务过多，请稍后再试');
  }

  const { data: underRate, error: rateError } = await admin.rpc('check_user_generation_rate', {
    p_user_id: ownerId,
    p_window_secs: RATE_WINDOW_SECS,
    p_max: RATE_MAX,
  });
  if (rateError) throw new ApiException('internal_error', rateError.message);
  if (underRate === false) throw new ApiException('rate_limited', '操作过于频繁，请稍后再试');

  const requestHash = await generationRequestHash(request);
  const generationId = crypto.randomUUID();
  const { data, error } = await admin.rpc('create_workflow_generation_submission', {
    p_requester_id: ownerId,
    p_generation_id: generationId,
    p_run_node_id: runNodeId,
    p_modality: request.modality,
    p_model_key: request.modelKey,
    p_prompt: request.prompt,
    p_params: request.params,
    p_idempotency_key: request.idempotencyKey,
    p_request_hash: requestHash,
    p_inputs: generationInputs(request),
  });
  if (error) {
    if (error.message.includes('MODEL_NOT_ACCESSIBLE')) {
      throw new ApiException('model_unavailable', '工作流绑定的模型当前不可用，请明确替换模型');
    }
    if (error.message.includes('IDEMPOTENCY_CONFLICT')) {
      throw new ApiException('idempotency_conflict', '工作流生成幂等键冲突');
    }
    if (error.message.includes('GENERATION_INPUT_FORBIDDEN')) {
      throw new ApiException('forbidden', '工作流引用了无权访问的资产');
    }
    throw new ApiException('internal_error', `创建工作流生成失败：${error.message}`);
  }
  const result = data as { generationId?: string; reused?: boolean } | null;
  if (!result?.generationId) throw new ApiException('internal_error', '工作流生成未返回任务标识');
  triggerFunction('process-generation-queue', { generationId: result.generationId });
  return { generationId: result.generationId, reused: Boolean(result.reused) };
}

/** 生成节点映射到既有图片操作字面量。 */
export function workflowImageOperation(kind: string): ReturnType<typeof normalizeImageOperation> {
  const map: Record<string, ReturnType<typeof normalizeImageOperation>> = {
    image_generate: 'generate',
    image_semantic_edit: 'semantic_edit',
    image_inpaint: 'inpaint',
    image_outpaint: 'outpaint',
    image_remove_background: 'remove_background',
    image_upscale: 'upscale',
  };
  return map[kind] ?? 'generate';
}
