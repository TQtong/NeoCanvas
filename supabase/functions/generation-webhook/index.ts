/**
 * 回调推进（generation-webhook）—— 推进阶段另一途径（第 06 篇第四节）。
 *
 * 接收支持回调的提供商完成通知。先做回调来源 / 签名校验（不依赖用户 JWT），再按回调
 * 携带的外部任务号反查对应任务并推进，就绪则结果落库。与轮询互为兜底；已终态忽略迟到
 * 回调。本端不依赖适配器 poll，而是直接消费回调载荷中的产出地址。
 *
 * @module functions/generation-webhook
 */

import { type AssetCandidate, type GenerationRow } from '../_shared/types.ts';
import { exceptionToResponse, fail, handleCorsPreflight, ok } from '../_shared/response.ts';
import { createAdminClient } from '../_shared/supabase.ts';
import { landResult, markFailed } from '../_shared/pipeline.ts';

/** 校验回调签名（与提供商约定的共享密钥）。 */
function verifySignature(request: Request, rawBody: string): boolean {
  const secret = Deno.env.get('GENERATION_WEBHOOK_SECRET');
  if (!secret) return true; // 未配置则不强制（开发环境）
  const provided = request.headers.get('x-webhook-secret') ?? request.headers.get('x-signature');
  return provided === secret;
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

Deno.serve(async (request) => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    const rawBody = await request.text();
    if (!verifySignature(request, rawBody)) {
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

    // 提取产出地址
    const urls: string[] = [];
    if (payload.video_url) urls.push(payload.video_url);
    if (typeof payload.output === 'string') urls.push(payload.output);
    if (Array.isArray(payload.output)) urls.push(...payload.output);

    if (urls.length === 0) {
      // 仅进度回调，更新进度
      await admin.from('generations').update({ progress: 70 }).eq('id', generation.id);
      return ok({ advanced: 'progress' });
    }

    const kind = generation.modality === 'video' ? 'video' : 'image';
    const candidates: AssetCandidate[] = urls.map((url) => ({
      kind,
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
