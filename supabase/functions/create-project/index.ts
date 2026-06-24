/**
 * 创建项目（create-project）—— 把主页「发起创作」落地为可进入的设计页（第 06 篇第四节）。
 *
 * 在一致边界内创建项目、会话与首条用户消息；若策略为「进入即生成首图」，则按所选模型
 * 创建一条 pending 生成任务并入队。返回新项目标识供客户端重定向至设计页。
 *
 * @module functions/create-project
 */

import {
  type CreateProjectRequest,
  type CreateProjectResponse,
  type ModelCatalogRow,
  type ReferenceMaterial,
  type UnifiedGenerationRequest,
} from '../_shared/types.ts';
import { ApiException, exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { createAdminClient, requireUser } from '../_shared/supabase.ts';
import {
  buildGenerationParams,
  composeScenePrompt,
  defaultPlacementSize,
} from '../_shared/params.ts';
import { createGeneration } from '../_shared/create-generation.ts';

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  try {
    const { userId } = await requireUser(request);
    const admin = createAdminClient();
    const body = (await request.json()) as CreateProjectRequest;

    const prompt = (body.prompt ?? '').trim();
    const modelKey = body.modelKey;
    const scene = body.scene ?? null;

    // 取模型（决定默认生成模态与参数）
    const { data: model } = await admin
      .from('model_catalog')
      .select('*')
      .eq('key', modelKey)
      .maybeSingle();
    const modelRow = model as ModelCatalogRow | null;

    // 在单一事务内原子创建「项目 + 会话 + 首条用户消息」，并按 client_request_id 去重
    // （连点重复请求复用既有项目而不重建，第 06 篇第四节）。
    const { data: rpcRows, error: rpcError } = await admin.rpc('create_project_with_conversation', {
      p_owner_id: userId,
      p_title: 'Untitled',
      p_scene: scene,
      p_model_key: modelKey,
      p_prompt: prompt || null,
      p_mentions: [],
      p_attachments: body.attachments ?? [],
      p_client_request_id: body.clientRequestId ?? null,
    });
    if (rpcError) {
      throw new ApiException('internal_error', `创建项目失败：${rpcError.message}`);
    }
    const created = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as {
      project_id: string;
      conversation_id: string;
      message_id: string;
      deduplicated: boolean;
    };
    const { project_id: projectId, conversation_id: conversationId, message_id: messageId } = created;

    // 进入即生成首图。以首条用户消息 id 作幂等键：重复请求（含连点命中幂等的项目）复用
    // 既有生成而不重复建任务。
    let generationId: string | null = null;
    let placeholderNodeId: string | null = null;
    if (body.generateOnCreate && prompt && modelRow && modelRow.is_active) {
      const references: ReferenceMaterial[] = (body.attachments ?? []).map((a) => ({
        origin: 'attachment',
        assetId: a.assetId,
        role: modelRow.modality === 'video' ? 'first_frame' : 'content',
      }));
      const params = buildGenerationParams(modelRow.modality, modelRow.default_params, references);
      const size = defaultPlacementSize(
        modelRow.modality,
        'aspectRatio' in params ? params.aspectRatio : undefined,
      );
      const genRequest: UnifiedGenerationRequest = {
        projectId,
        conversationId,
        messageId,
        modality: modelRow.modality,
        modelKey,
        prompt: composeScenePrompt(scene, prompt),
        params,
        idempotencyKey: messageId,
        placement: { x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height },
      };
      const result = await createGeneration(admin, genRequest, userId);
      generationId = result.generationId;
      placeholderNodeId = result.placeholderNodeId;
    }

    const response: CreateProjectResponse = {
      projectId,
      conversationId,
      messageId,
      generationId,
      placeholderNodeId,
    };
    return ok(response);
  } catch (error) {
    return exceptionToResponse(error);
  }
});
