/**
 * Google 图像适配器 —— Nano Banana Pro（第 05 篇第三节）。
 *
 * 对接 Google Generative Language（Gemini）的图像生成 / 编辑能力，擅长高保真与图像
 * 编辑，支持以参考图为条件生成。同步返回，产出以内联 base64 归一化。
 *
 * @module functions/_shared/adapters/google
 */

import {
  type ImageGenerationParams,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';
import {
  fetchReferenceBase64,
  requireProviderKey,
  resolveSize,
  type ModelAdapter,
  type ModelContext,
} from './base.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export const googleAdapter: ModelAdapter = {
  provider: 'google' as Provider,

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (request.modality !== 'image') {
      throw new ApiException('unsupported_param', 'Google 适配器仅支持图像模态');
    }
    const apiKey = requireProviderKey('GOOGLE_API_KEY', 'google');
    const params = request.params as ImageGenerationParams;
    const { width, height } = resolveSize(params);

    // 组装多模态内容：文本提示 + 参考图（内联 base64）
    const parts: GeminiPart[] = [{ text: request.prompt }];
    for (const ref of ctx.references) {
      const { base64, mimeType } = await fetchReferenceBase64(ref);
      parts.push({ inlineData: { mimeType, data: base64 } });
    }

    const response = await fetch(
      `${API_BASE}/models/${ctx.providerModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `Google 生成失败（${response.status}）`, {
        upstream: text.slice(0, 500),
      });
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    };

    const candidates = (json.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .filter((p): p is Required<Pick<GeminiPart, 'inlineData'>> => Boolean(p.inlineData))
      .map((p) => ({
        kind: 'image' as const,
        mimeType: p.inlineData.mimeType || 'image/png',
        fetch: { type: 'base64' as const, data: p.inlineData.data },
        width,
        height,
        isEphemeral: false,
      }));

    if (candidates.length === 0) {
      throw new ApiException('content_blocked', 'Google 未返回图像（可能被安全策略拦截）');
    }
    return { kind: 'sync', candidates };
  },

  poll(): Promise<PollResult> {
    return Promise.reject(new ApiException('internal_error', 'Google 图像为同步模型，不应轮询'));
  },
};
