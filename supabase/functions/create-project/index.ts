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

    // 建项目
    const projectId = crypto.randomUUID();
    const { error: projectError } = await admin.from('projects').insert({
      id: projectId,
      owner_id: userId,
      title: 'Untitled',
      viewport: { x: 0, y: 0, zoom: 1 },
      initial_scene: scene,
      default_model_key: modelKey,
      last_opened_at: new Date().toISOString(),
    });
    if (projectError) {
      throw new ApiException('internal_error', `创建项目失败：${projectError.message}`);
    }

    // 建会话
    const conversationId = crypto.randomUUID();
    await admin.from('conversations').insert({
      id: conversationId,
      project_id: projectId,
      title: '新对话',
    });

    // 建首条用户消息
    const messageId = crypto.randomUUID();
    await admin.from('messages').insert({
      id: messageId,
      conversation_id: conversationId,
      role: 'user',
      content: prompt || null,
      model_key: modelKey,
      agent_mode: 'generate',
      attachments: body.attachments ?? [],
    });

    // 进入即生成首图
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
        idempotencyKey: body.clientRequestId ?? crypto.randomUUID(),
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
