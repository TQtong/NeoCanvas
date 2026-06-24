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

import { type AssetCandidate, type GenerationRow, type ModelCatalogRow } from '../_shared/types.ts';
import { exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { createAdminClient } from '../_shared/supabase.ts';
import { landResult, markFailed, resolveProviderModel } from '../_shared/pipeline.ts';
import { getAdapter } from '../_shared/adapters/registry.ts';
import { type ModelContext } from '../_shared/adapters/base.ts';

/** 候选签名头（不同提供商命名各异，取并集）。 */
const SIGNATURE_HEADERS = ['x-webhook-signature', 'x-signature', 'x-hub-signature-256'];

/** 十六进制编码。 */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 常数时间字符串比较（避免计时侧信道）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * 以 HMAC-SHA256(secret, rawBody) 校验回调签名（fail-closed）。
 *
 * 契约要求对回调做签名校验：未配置 GENERATION_WEBHOOK_SECRET 时无法验证，一律拒绝；
 * 缺少签名头或签名不匹配亦拒绝。容许签名头带 `sha256=` 前缀（十六进制小写）。
 */
async function verifySignature(request: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get('GENERATION_WEBHOOK_SECRET');
  if (!secret) return false; // 未配置密钥即无法验证 → 拒绝

  let provided: string | null = null;
  for (const h of SIGNATURE_HEADERS) {
    const v = request.headers.get(h);
    if (v) {
      provided = v;
      break;
    }
  }
  if (!provided) return false;
  const sig = (provided.startsWith('sha256=') ? provided.slice(7) : provided).toLowerCase();

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(sig, toHex(mac));
}

/** 通用回调载荷（不同提供商字段名各异，此处取并集）。 */
interface WebhookPayload {
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
): Promise<{ done: 'succeeded'; candidates: AssetCandidate[] } | { done: 'failed'; error: string } | { done: 'running'; progress: number } | null> {
  if (!generation.external_job_id) return null;
  const { data: model } = await admin
    .from('model_catalog')
    .select('*')
    .eq('key', generation.model_key)
    .maybeSingle();
  const modelRow = model as ModelCatalogRow | null;
  if (!modelRow) return null;
  try {
    const ctx: ModelContext = {
      modelKey: modelRow.key,
      capabilities: modelRow.capabilities,
      providerModel: resolveProviderModel(modelRow.key, modelRow.provider, modelRow.default_params),
      references: [],
    };
    const result = await getAdapter(generation.provider).poll(generation.external_job_id, ctx);
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

  try {
    const rawBody = await request.text();
    if (!(await verifySignature(request, rawBody))) {
      return fail('unauthorized', '回调签名校验失败');
    }
    const payload = JSON.parse(rawBody) as WebhookPayload;
    const externalJobId = payload.externalJobId ?? payload.id;
    if (!externalJobId) {
      return fail('invalid_params', '回调缺少外部任务号');
    }

    const admin = createAdminClient();
    const { data: gen } = await admin
      .from('generations')
      .select('*')
      .eq('external_job_id', externalJobId)
      .maybeSingle();
    if (!gen) {
      return ok({ ignored: true, reason: '未找到对应任务' });
    }
    const generation = gen as GenerationRow;

    // 已终态忽略迟到回调（状态机幂等）
    if (generation.status === 'succeeded' || generation.status === 'failed') {
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
        .eq('id', generation.id);
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
        .eq('id', generation.id);
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
    return exceptionToResponse(error);
  }
});
