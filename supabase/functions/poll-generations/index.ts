/**
 * 轮询推进（poll-generations）—— 推进阶段兜底途径之一（第 06 篇第四节）。
 *
 * 由 pg_cron 定时触发，批量拉取处于 running 且为异步的任务，经适配器查询语义向提供商
 * 查询进度，回写状态；就绪则结果落库。以服务角色运行，已终态任务跳过，重复轮询安全。
 *
 * @module functions/poll-generations
 */

import { type GenerationRow, type ModelCatalogRow } from '../_shared/types.ts';
import { exceptionToResponse, ok } from '../_shared/response.ts';
import { createAdminClient, type SupabaseClient } from '../_shared/supabase.ts';
import { getAdapter } from '../_shared/adapters/registry.ts';
import { resolveProviderAdapter } from '../_shared/credentials.ts';
import { buildModelContext, landResult, markFailed } from '../_shared/pipeline.ts';

/** 单次轮询的最大任务数。 */
const BATCH = 20;

/** 推进单条异步任务。 */
async function advance(admin: SupabaseClient, generation: GenerationRow): Promise<void> {
  if (!generation.external_job_id) return;

  const { data: model } = await admin
    .from('model_catalog')
    .select('*')
    .eq('key', generation.model_key)
    .single();
  const modelRow = model as ModelCatalogRow;

  const adapter = getAdapter(
    await resolveProviderAdapter(admin, generation.provider, generation.project_id),
  );
  const ctx = await buildModelContext(
    admin,
    {
      projectId: generation.project_id,
      conversationId: generation.conversation_id,
      messageId: generation.message_id,
      modality: generation.modality,
      modelKey: generation.model_key,
      prompt: generation.prompt ?? '',
      params: generation.params,
      idempotencyKey: generation.idempotency_key ?? '',
    },
    modelRow,
  );

  try {
    const result = await adapter.poll(generation.external_job_id, ctx);
    if (result.status === 'running') {
      await admin
        .from('generations')
        .update({ progress: Math.max(generation.progress, result.progress) })
        .eq('id', generation.id);
    } else if (result.status === 'succeeded') {
      await landResult(admin, generation, result.candidates);
    } else {
      await markFailed(admin, generation, result.error);
    }
  } catch (error) {
    // 查询失败不立即判失败，留待下次轮询；仅在提供商明确失败时置 failed
    console.error(`轮询任务 ${generation.id} 失败`, error);
  }
}

Deno.serve(async () => {
  try {
    const admin = createAdminClient();
    const { data: rows } = await admin
      .from('generations')
      .select('*')
      .eq('status', 'running')
      .not('external_job_id', 'is', null)
      .order('updated_at', { ascending: true })
      .limit(BATCH);

    const generations = (rows ?? []) as GenerationRow[];
    for (const generation of generations) {
      await advance(admin, generation);
    }
    return ok({ polled: generations.length });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
