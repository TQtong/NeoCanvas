/**
 * fal.ai 聚合平台适配器（预留，第 05 篇第三节）。
 *
 * 以「提交任务 → 轮询取结果」对接 fal 队列 API，天然契合异步流水线。模型路径来自
 * `model_catalog.default_params.providerModel`。未配置密钥时以 model_unavailable 拒绝。
 *
 * @module functions/_shared/adapters/fal
 */

import {
  type ImageGenerationParams,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { type ModelAdapter, type ModelContext, resolveSize } from './base.ts';

const QUEUE_BASE = 'https://queue.fal.run';

/** 解析 fal 队列基址：优先用户自定义端点，否则默认。 */
function queueBase(ctx: ModelContext): string {
  return (ctx.credentials.baseUrl ?? QUEUE_BASE).replace(/\/$/, '');
}

export const falAdapter: ModelAdapter = {
  provider: 'fal' as Provider,
  supportedOperations: ['generate', 'semantic_edit'],

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    const apiKey = ctx.credentials.apiKey;
    const base = queueBase(ctx);
    const input: Record<string, unknown> = { prompt: request.prompt };
    if (request.modality === 'image') {
      const params = request.params as ImageGenerationParams;
      const { width, height } = resolveSize(params);
      input.image_size = { width, height };
      input.num_images = Math.min(params.count || 1, ctx.capabilities.maxOutputs);
      const ref = ctx.references[0];
      if (ref) input.image_url = ref.url;
    }

    const response = await fetch(`${base}/${ctx.providerModel}`, {
      method: 'POST',
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `fal 提交失败（${response.status}）`, {
        upstream: text.slice(0, 300),
      });
    }
    const json = (await response.json()) as { request_id?: string };
    if (!json.request_id) throw new ApiException('provider_error', 'fal 未返回请求号');
    return { kind: 'async', externalJobId: json.request_id, progress: 5 };
  },

  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const apiKey = ctx.credentials.apiKey;
    const base = queueBase(ctx);
    const headers = { Authorization: `Key ${apiKey}` };
    const statusRes = await fetch(
      `${base}/${ctx.providerModel}/requests/${externalJobId}/status`,
      { headers },
    );
    if (!statusRes.ok) {
      throw new ApiException('provider_error', `fal 状态查询失败（${statusRes.status}）`);
    }
    const status = (await statusRes.json()) as { status?: string };

    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(
        `${base}/${ctx.providerModel}/requests/${externalJobId}`,
        { headers },
      );
      const result = (await resultRes.json()) as {
        images?: Array<{ url: string; content_type?: string }>;
        video?: { url: string };
      };
      if (result.video?.url) {
        return {
          status: 'succeeded',
          candidates: [
            {
              kind: 'video',
              mimeType: 'video/mp4',
              fetch: { type: 'url', url: result.video.url },
              isEphemeral: true,
            },
          ],
        };
      }
      const candidates = (result.images ?? []).map((img) => ({
        kind: 'image' as const,
        mimeType: img.content_type ?? 'image/png',
        fetch: { type: 'url' as const, url: img.url },
        isEphemeral: true,
      }));
      if (candidates.length === 0) return { status: 'failed', error: 'fal 未返回产出' };
      return { status: 'succeeded', candidates };
    }
    if (status.status === 'IN_PROGRESS') return { status: 'running', progress: 60 };
    return { status: 'running', progress: 20 };
  },
};
