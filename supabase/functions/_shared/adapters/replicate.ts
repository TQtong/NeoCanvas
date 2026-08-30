/**
 * Replicate 聚合平台适配器（预留，第 05 篇第三节）。
 *
 * 以「创建 prediction → 轮询取结果」对接 Replicate。模型版本来自
 * `model_catalog.default_params.providerModel`（版本哈希）。未配置 token 时拒绝。
 *
 * @module functions/_shared/adapters/replicate
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

const API_BASE = 'https://api.replicate.com/v1';

/** 解析 Replicate 基址：优先用户自定义端点，否则默认。 */
function apiBase(ctx: ModelContext): string {
  return (ctx.credentials.baseUrl ?? API_BASE).replace(/\/$/, '');
}

export const replicateAdapter: ModelAdapter = {
  provider: 'replicate' as Provider,
  supportedOperations: ['generate', 'semantic_edit'],

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    const token = ctx.credentials.apiKey;
    const input: Record<string, unknown> = { prompt: request.prompt };
    if (request.modality === 'image') {
      const params = request.params as ImageGenerationParams;
      const { width, height } = resolveSize(params);
      input.width = width;
      input.height = height;
      input.num_outputs = Math.min(params.count || 1, ctx.capabilities.maxOutputs);
      const ref = ctx.references[0];
      if (ref) input.image = ref.url;
    }

    const response = await fetch(`${apiBase(ctx)}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: ctx.providerModel, input }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `Replicate 提交失败（${response.status}）`, {
        upstream: text.slice(0, 300),
      });
    }
    const json = (await response.json()) as { id?: string };
    if (!json.id) throw new ApiException('provider_error', 'Replicate 未返回预测号');
    return { kind: 'async', externalJobId: json.id, progress: 5 };
  },

  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const token = ctx.credentials.apiKey;
    const response = await fetch(`${apiBase(ctx)}/predictions/${externalJobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new ApiException('provider_error', `Replicate 查询失败（${response.status}）`);
    }
    const json = (await response.json()) as {
      status?: string;
      output?: string | string[];
      error?: string;
    };

    if (json.status === 'succeeded') {
      const outputs = Array.isArray(json.output) ? json.output : json.output ? [json.output] : [];
      const candidates = outputs.map((url) => ({
        kind: 'image' as const,
        mimeType: 'image/png',
        fetch: { type: 'url' as const, url },
        isEphemeral: true,
      }));
      if (candidates.length === 0) return { status: 'failed', error: 'Replicate 未返回产出' };
      return { status: 'succeeded', candidates };
    }
    if (json.status === 'failed' || json.status === 'canceled') {
      return { status: 'failed', error: json.error ?? 'Replicate 任务失败' };
    }
    return { status: 'running', progress: json.status === 'processing' ? 60 : 20 };
  },
};
