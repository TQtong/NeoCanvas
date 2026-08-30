/**
 * 消费队列（process-generation-queue）—— 流水线执行阶段（第 06 篇第四节）。
 *
 * 由队列投递 / cron 兜底触发，从待处理队列取出任务置 running，经适配器提交。同步模型
 * 提交即得产出直接落库完成；异步模型记录外部任务号、保持 running 等待轮询 / 回调推进。
 * 以服务角色运行，状态机单向转移保证重复消费安全；瞬时错误有限次重试。
 *
 * @module functions/process-generation-queue
 */

import { type GenerationRow, type ModelCatalogRow } from '../_shared/types.ts';
import { exceptionToResponse, fail, ok } from '../_shared/response.ts';
import { createAdminClient, type SupabaseClient } from '../_shared/supabase.ts';
import { getAdapter } from '../_shared/adapters/registry.ts';
import { resolveProviderAdapter } from '../_shared/credentials.ts';
import { buildModelContext, landResult, markFailed } from '../_shared/pipeline.ts';
import { requireInternalServiceRole } from '../_shared/internal-auth.ts';
import { requireAccessibleModel } from '../_shared/models.ts';
import { normalizeProviderError } from '../_shared/provider-errors.ts';

/** 单次消费的最大任务数。 */
const BATCH = 5;
/** 瞬时错误的最大重试次数。 */
const MAX_RETRIES = 3;

/** 瞬时错误码（可自动重试）。 */
const TRANSIENT_CODES = new Set(['provider_error', 'rate_limited']);

/** 瞬时失败的退避基数（秒）与上限（秒）。 */
const BACKOFF_BASE_SECS = 30;
const BACKOFF_MAX_SECS = 300;

/** 生成不可猜测的每任务回调 secret（仅内存传给适配器）。 */
function webhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/** 对回调 secret 做不可逆 SHA-256，数据库不保存明文。 */
async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 按已读次数计算指数退避秒数。 */
function backoffSeconds(readCount: number): number {
  return Math.min(BACKOFF_MAX_SECS, BACKOFF_BASE_SECS * 2 ** Math.max(0, readCount - 1));
}

/** 处理单条队列任务。 */
async function processJob(
  admin: SupabaseClient,
  generationId: string,
  readCount: number,
  msgId: number,
): Promise<void> {
  const { data: gen } = await admin
    .from('generations')
    .select('*')
    .eq('id', generationId)
    .maybeSingle();
  if (!gen) return;
  const generation = gen as GenerationRow;

  // 仅 pending 可被消费置 running（状态机幂等）
  if (generation.status !== 'pending') return;

  const { data: claimed, error: claimError } = await admin
    .from('generations')
    .update({ status: 'running', progress: 10 })
    .eq('id', generationId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;

  try {
    const modelRow: ModelCatalogRow = await requireAccessibleModel(
      admin,
      generation.model_key,
      generation.requester_id,
      generation.modality,
    );

    const adapter = getAdapter(
      await resolveProviderAdapter(admin, generation.provider, generation.project_id),
    );
    const baseContext = await buildModelContext(
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

    let callbackSecret: string | null = null;
    let callbackSecretHash: string | null = null;
    let callbackExpiresAt: string | null = null;
    const functionBaseUrl = Deno.env.get('SUPABASE_URL');
    if (modelRow.capabilities.supportsWebhook && functionBaseUrl) {
      callbackSecret = webhookSecret();
      callbackSecretHash = await sha256(callbackSecret);
      callbackExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    const ctx = callbackSecret
      ? {
        ...baseContext,
        webhookCallback: {
          url: `${functionBaseUrl}/functions/v1/generation-webhook`,
          secret: callbackSecret,
          expiresAt: callbackExpiresAt!,
        },
      }
      : baseContext;

    const submitResult = await adapter.submit(
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
      ctx,
    );

    if (submitResult.kind === 'sync') {
      await landResult(admin, { ...generation, status: 'running' }, submitResult.candidates);
    } else {
      // 异步：记录外部任务号，保持 running，待轮询 / 回调推进
      const { error: externalJobError } = await admin
        .from('generations')
        .update({
          external_job_id: submitResult.externalJobId,
          progress: submitResult.progress ?? 15,
          webhook_secret_hash: callbackSecretHash,
          webhook_secret_expires_at: callbackExpiresAt,
        })
        .eq('id', generationId)
        .eq('status', 'running');
      if (externalJobError) {
        throw new Error(`保存提供商任务号失败：${externalJobError.message}`);
      }
    }
  } catch (error) {
    const normalized = normalizeProviderError(error, generation.provider);
    if (normalized.retryable) {
      console.warn(
        `Provider 瞬时错误 generation=${generation.id} provider=${generation.provider} attempt=${readCount}: ${normalized.diagnostic}`,
      );
    }
    if (TRANSIENT_CODES.has(normalized.code) && readCount <= MAX_RETRIES) {
      // 瞬时错误：回退为 pending，并对该消息设置指数退避的可见性超时后留待重试
      await admin
        .from('generations')
        .update({ status: 'pending' })
        .eq('id', generationId)
        .eq('status', 'running');
      await admin.rpc('set_generation_job_vt', {
        p_msg_id: msgId,
        p_vt: backoffSeconds(readCount),
      });
      throw error; // 不删除消息，留待退避后重试
    }
    await markFailed(
      admin,
      { ...generation, status: 'running' },
      normalized.message,
      undefined,
      normalized.code,
    );
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');
  try {
    requireInternalServiceRole(request);
    const admin = createAdminClient();
    const { data: jobs } = await admin.rpc('read_generation_jobs', { p_qty: BATCH, p_vt: 90 });
    const rows = (jobs ?? []) as Array<{
      msg_id: number;
      read_ct: number;
      message: { generationId: string };
    }>;

    let processed = 0;
    for (const job of rows) {
      try {
        await processJob(admin, job.message.generationId, job.read_ct, job.msg_id);
        await admin.rpc('delete_generation_job', { p_msg_id: job.msg_id });
        processed += 1;
      } catch {
        // 留待退避后的可见性超时重试，不删除消息
      }
    }
    return ok({ processed, total: rows.length });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
