/**
 * 回调推进（generation-webhook）—— 推进阶段另一途径（第 06 篇第四节）。
 *
 * 接收支持回调的提供商完成通知。先做回调来源 / 签名校验（不依赖用户 JWT），再按回调
 * 携带的外部任务号反查对应任务并推进，就绪则结果落库。与轮询互为兜底；已终态忽略迟到
 * 回调。
 *
 * 归一化：优先经适配器 `poll` 复用提供商响应解析得到规范候选（含真实 MIME / 尺寸）；
 * 适配器不可用时回退为消费回调载荷中的产出地址，由落库阶段按实际 Content-Type 判定 MIME。
 *
 * @module functions/generation-webhook
 */

import { type AssetCandidate, type GenerationRow, TERMINAL_STATUSES } from '../_shared/types.ts';
import { exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { createAdminClient } from '../_shared/supabase.ts';
import { landResult, markFailed, resolveProviderModel } from '../_shared/pipeline.ts';
import { resolveProviderAdapter, resolveProviderCredential } from '../_shared/credentials.ts';
import { getAdapter } from '../_shared/adapters/registry.ts';
import { type ModelContext } from '../_shared/adapters/base.ts';
import { requireAccessibleModel } from '../_shared/models.ts';
import { verifyGenerationWebhookSignature, webhookEventKey } from '../_shared/webhook-auth.ts';

/** 通用回调载荷（不同提供商字段名各异，此处取并集）。 */
interface WebhookPayload {
  provider?: string;
  eventId?: string;
  event_id?: string;
  externalJobId?: string;
  id?: string;
  status?: string;
  output?: string | string[];
  video_url?: string;
  error?: string;
}

/** 尝试经适配器 poll 归一化产出；不可用返回 null（交回退路径）。 */
async function pollViaAdapter(
  admin: ReturnType<typeof createAdminClient>,
  generation: GenerationRow,
): Promise<
  | { done: 'succeeded'; candidates: AssetCandidate[] }
  | { done: 'failed'; error: string }
  | { done: 'running'; progress: number }
  | null
> {
  if (!generation.external_job_id) return null;
  const modelRow = await requireAccessibleModel(
    admin,
    generation.model_key,
    generation.requester_id,
    generation.modality,
  );
  try {
    // 回调推进同样按任务归属用户解析凭证（用户凭证 → 环境变量回退）
    const credentials = await resolveProviderCredential(
      admin,
      generation.provider,
      generation.project_id,
    );
    const ctx: ModelContext = {
      modelKey: modelRow.key,
      capabilities: modelRow.capabilities,
      providerModel: resolveProviderModel(modelRow.key, modelRow.provider, modelRow.default_params),
      references: [],
      // 轮询 / 回调阶段不需要关键帧（提交已完成），置空满足上下文契约
      keyframes: [],
      credentials,
    };
    const adapter = getAdapter(
      await resolveProviderAdapter(admin, generation.provider, generation.project_id),
    );
    const result = await adapter.poll(generation.external_job_id, ctx);
    if (result.status === 'succeeded') return { done: 'succeeded', candidates: result.candidates };
    if (result.status === 'failed') return { done: 'failed', error: result.error };
    return { done: 'running', progress: result.progress };
  } catch {
    return null; // 提供商不支持二次 poll 时回退到载荷地址
  }
}

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');

  let claimedEvent: { provider: string; eventKey: string } | null = null;
  try {
    const rawBody = await request.text();
    const payload = JSON.parse(rawBody) as WebhookPayload;
    const externalJobId = payload.externalJobId ?? payload.id;
    if (!externalJobId || !payload.provider) {
      return fail('invalid_params', '回调缺少 Provider 或外部任务号');
    }

    const admin = createAdminClient();
    const { data: gen } = await admin
      .from('generations')
      .select('*')
      .eq('provider', payload.provider)
      .eq('external_job_id', externalJobId)
      .maybeSingle();
    if (!gen) {
      // 不向未验证调用方泄露外部任务号是否存在。
      return fail('provider_signature_invalid', '回调签名或任务标识无效');
    }
    const generation = gen as GenerationRow;

    const verification = await verifyGenerationWebhookSignature(request, rawBody, {
      provider: generation.provider,
      webhookSecretHash: generation.webhook_secret_hash,
      webhookSecretExpiresAt: generation.webhook_secret_expires_at,
    });
    if (!verification.valid || !verification.timestamp) {
      return fail('provider_signature_invalid', '回调签名无效、已过期或缺少时间戳');
    }

    const eventKey = await webhookEventKey(
      verification.timestamp,
      rawBody,
      payload.eventId ?? payload.event_id,
    );
    const { error: eventError } = await admin.from('generation_webhook_events').insert({
      generation_id: generation.id,
      provider: generation.provider,
      event_key: eventKey,
    });
    if (eventError?.code === '23505') {
      return ok({ ignored: true, reason: '重复回调事件' });
    }
    if (eventError) throw eventError;
    claimedEvent = { provider: generation.provider, eventKey };

    // 已终态忽略迟到回调（状态机幂等）
    if (TERMINAL_STATUSES.has(generation.status)) {
      return ok({ ignored: true, reason: '任务已终态' });
    }

    const status = (payload.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'error' || status === 'canceled') {
      await markFailed(admin, generation, payload.error ?? '提供商回调报告失败');
      return ok({ advanced: 'failed' });
    }

    // 优先经适配器归一化
    const viaAdapter = await pollViaAdapter(admin, generation);
    if (viaAdapter) {
      if (viaAdapter.done === 'succeeded') {
        await landResult(admin, generation, viaAdapter.candidates);
        return ok({ advanced: 'succeeded', via: 'adapter' });
      }
      if (viaAdapter.done === 'failed') {
        await markFailed(admin, generation, viaAdapter.error);
        return ok({ advanced: 'failed', via: 'adapter' });
      }
      await admin
        .from('generations')
        .update({ progress: Math.max(generation.progress, viaAdapter.progress) })
        .eq('id', generation.id)
        .eq('status', 'running');
      return ok({ advanced: 'progress', via: 'adapter' });
    }

    // 回退：消费回调载荷中的产出地址（MIME 由落库阶段按实际 Content-Type 判定）
    const urls: string[] = [];
    if (payload.video_url) urls.push(payload.video_url);
    if (typeof payload.output === 'string') urls.push(payload.output);
    if (Array.isArray(payload.output)) urls.push(...payload.output);

    if (urls.length === 0) {
      await admin
        .from('generations')
        .update({ progress: Math.max(generation.progress, 70) })
        .eq('id', generation.id)
        .eq('status', 'running');
      return ok({ advanced: 'progress' });
    }

    const kind = generation.modality === 'video' ? 'video' : 'image';
    const candidates: AssetCandidate[] = urls.map((url) => ({
      kind,
      // 兜底 MIME；落库阶段以响应 Content-Type 校正
      mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
      fetch: { type: 'url', url },
      isEphemeral: true,
    }));
    await landResult(admin, generation, candidates);
    return ok({ advanced: 'succeeded' });
  } catch (error) {
    // 处理失败时释放重放占位，允许 Provider 用同一事件安全重试；业务终态仍由行锁 RPC 去重。
    if (claimedEvent) {
      const admin = createAdminClient();
      await admin
        .from('generation_webhook_events')
        .delete()
        .eq('provider', claimedEvent.provider)
        .eq('event_key', claimedEvent.eventKey);
    }
    return exceptionToResponse(error);
  }
});
