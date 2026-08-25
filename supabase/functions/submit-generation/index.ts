/**
 * 提交生成（submit-generation）—— 生成流水线入口（第 06 篇第四节）。
 *
 * 校验调用者身份与项目归属、按能力画像校验参数、内容安全审核；在 generations 建一条
 * pending 任务，在画布建一个生成占位节点并与任务互相关联，把任务投入队列。返回任务与
 * 占位节点标识，客户端据此立即显示进行态与占位，后续经实时面回流。幂等键去重。
 *
 * @module functions/submit-generation
 */

import { type SubmitGenerationResponse, type UnifiedGenerationRequest } from '../_shared/types.ts';
import {
  ApiException,
  exceptionToResponse,
  fail,
  handleCorsPreflight,
  ok,
} from '../_shared/response.ts';
import { assertProjectOwner, createAdminClient, requireUser } from '../_shared/supabase.ts';
import { createGeneration } from '../_shared/create-generation.ts';

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  try {
    const { userId } = await requireUser(request);
    const admin = createAdminClient();
    const body = (await request.json()) as UnifiedGenerationRequest;

    if (!body.projectId || !body.modelKey || !body.modality) {
      throw new ApiException('invalid_params', '缺少必要字段');
    }
    await assertProjectOwner(admin, body.projectId, userId);

    const result = await createGeneration(admin, body, userId);
    return ok<SubmitGenerationResponse>(result);
  } catch (error) {
    return exceptionToResponse(error);
  }
});
