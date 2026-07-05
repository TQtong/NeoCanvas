/**
 * OpenAI 图像适配器 —— GPT Image 2（第 05 篇第三节）。
 *
 * 对接 OpenAI 图像生成接口。文生图走 `/v1/images/generations`，带参考图的编辑走
 * `/v1/images/edits`（multipart）。多为同步返回，产出以 base64 归一化为资产候选。
 *
 * @module functions/_shared/adapters/openai
 */

import {
  type ImageGenerationParams,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { resolveSize, type ModelAdapter, type ModelContext } from './base.ts';

const API_BASE = 'https://api.openai.com/v1';

/** 把宽高映射到 OpenAI 支持的 size 取值。 */
function toOpenAISize(width: number, height: number): string {
  if (width === height) return '1024x1024';
  return width > height ? '1536x1024' : '1024x1536';
}

export const openaiAdapter: ModelAdapter = {
  provider: 'openai' as Provider,

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (request.modality !== 'image') {
      throw new ApiException('unsupported_param', 'OpenAI 适配器仅支持图像模态');
    }
    const apiKey = ctx.credentials.apiKey;
    const baseUrl = (ctx.credentials.baseUrl ?? API_BASE).replace(/\/$/, '');
    const params = request.params as ImageGenerationParams;
    const { width, height } = resolveSize(params);
    const size = toOpenAISize(width, height);
    const count = Math.min(params.count || 1, ctx.capabilities.maxOutputs);

    let response: Response;
    if (ctx.references.length > 0) {
      // 带参考图 → 编辑接口（multipart）
      const form = new FormData();
      form.append('model', ctx.providerModel);
      form.append('prompt', request.prompt);
      form.append('n', String(count));
      form.append('size', size);
      if (params.quality && params.quality !== 'auto') form.append('quality', params.quality);
      for (const ref of ctx.references) {
        const res = await fetch(ref.url);
        if (!res.ok) throw new ApiException('provider_error', '取参考图失败');
        const blob = await res.blob();
        form.append('image[]', blob, `reference.${ref.mimeType.split('/')[1] ?? 'png'}`);
      }
      response = await fetch(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } else {
      const body: Record<string, unknown> = {
        model: ctx.providerModel,
        prompt: request.prompt,
        n: count,
        size,
      };
      if (params.quality && params.quality !== 'auto') body.quality = params.quality;
      response = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `OpenAI 生成失败（${response.status}）`, {
        upstream: text.slice(0, 500),
      });
    }

    const json = (await response.json()) as {
      data: Array<{ b64_json?: string; url?: string }>;
    };

    const candidates = (json.data ?? []).map((item) => {
      if (item.b64_json) {
        return {
          kind: 'image' as const,
          mimeType: 'image/png',
          fetch: { type: 'base64' as const, data: item.b64_json },
          width,
          height,
          isEphemeral: false,
        };
      }
      return {
        kind: 'image' as const,
        mimeType: 'image/png',
        fetch: { type: 'url' as const, url: item.url ?? '' },
        width,
        height,
        isEphemeral: true,
      };
    });

    if (candidates.length === 0) {
      throw new ApiException('provider_error', 'OpenAI 未返回任何图像');
    }
    return { kind: 'sync', candidates };
  },

  poll(): Promise<PollResult> {
    // GPT Image 为同步模型，无异步查询语义
    return Promise.reject(new ApiException('internal_error', 'OpenAI 图像为同步模型，不应轮询'));
  },
};
