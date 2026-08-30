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
  normalizeImageOperation,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { fetchReferenceBase64, type ModelAdapter, type ModelContext, resolveSize } from './base.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  /** Gemini 3 图片模型的中间推理图；不得作为用户候选落库。 */
  thought?: boolean;
}

/** 把 NeoCanvas 尺寸档映射为 Gemini 图片接口接受的离散分辨率。 */
function googleImageSize(params: ImageGenerationParams): '1K' | '2K' | '4K' {
  if (params.sizePreset === '4k' || params.sizePreset === '8k') return '4K';
  if (params.sizePreset === '2k') return '2K';
  const longestEdge = Math.max(params.width ?? 0, params.height ?? 0);
  if (longestEdge >= 3072) return '4K';
  if (longestEdge >= 1536) return '2K';
  return '1K';
}

/**
 * 校验 Google 原生图片协议的操作边界。
 *
 * Google 的图片编辑是语义编辑：内容源图与可选风格图和提示词放在同一个用户消息中；
 * 它没有像素蒙版字段，因此任何局部重绘、扩图或工具型请求都必须显式失败。
 */
function assertGoogleImageInputs(request: UnifiedGenerationRequest, ctx: ModelContext): void {
  const params = request.params as ImageGenerationParams;
  const operation = normalizeImageOperation(params);
  if (operation !== 'generate' && operation !== 'semantic_edit') {
    throw new ApiException('unsupported_param', `Google 不支持图片操作 ${operation}`);
  }

  if (operation === 'generate') {
    if (ctx.references.length > 0) {
      throw new ApiException('unsupported_param', 'Google 普通生成请求不能携带编辑源图');
    }
    return;
  }

  const contentCount = ctx.references.filter((reference) => reference.role === 'content').length;
  const hasUnsupportedRole = ctx.references.some(
    (reference) => reference.role !== 'content' && reference.role !== 'style',
  );
  if (contentCount !== 1 || hasUnsupportedRole) {
    throw new ApiException(
      'unsupported_param',
      'Google 语义编辑必须包含且仅包含一个内容源图，并且只能追加风格参考图',
    );
  }
}

export const googleAdapter: ModelAdapter = {
  provider: 'google' as Provider,
  supportedOperations: ['generate', 'semantic_edit'],

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (request.modality !== 'image') {
      throw new ApiException('unsupported_param', 'Google 适配器仅支持图像模态');
    }
    const apiKey = ctx.credentials.apiKey;
    const baseUrl = (ctx.credentials.baseUrl ?? API_BASE).replace(/\/$/, '');
    const params = request.params as ImageGenerationParams;
    const { width, height } = resolveSize(params);
    assertGoogleImageInputs(request, ctx);

    // 组装多模态内容：文本提示 + 参考图（内联 base64）
    const parts: GeminiPart[] = [{ text: request.prompt }];
    for (const ref of ctx.references) {
      const { base64, mimeType } = await fetchReferenceBase64(ref);
      parts.push({ inlineData: { mimeType, data: base64 } });
    }

    const response = await fetch(
      `${baseUrl}/models/${encodeURIComponent(ctx.providerModel)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            ...(params.seed != null ? { seed: params.seed } : {}),
            responseFormat: {
              image: {
                aspectRatio: params.aspectRatio ?? '1:1',
                imageSize: googleImageSize(params),
              },
            },
          },
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
      .filter(
        (p): p is Required<Pick<GeminiPart, 'inlineData'>> & GeminiPart =>
          !p.thought && Boolean(p.inlineData?.data),
      )
      .map((p) => ({
        kind: 'image' as const,
        mimeType: p.inlineData.mimeType || 'image/png',
        fetch: { type: 'base64' as const, data: p.inlineData.data },
        width,
        height,
        isEphemeral: false,
      }))
      .slice(0, Math.min(params.count || 1, ctx.capabilities.maxOutputs));

    if (candidates.length === 0) {
      throw new ApiException('content_blocked', 'Google 未返回图像（可能被安全策略拦截）');
    }
    return { kind: 'sync', candidates };
  },

  poll(): Promise<PollResult> {
    return Promise.reject(new ApiException('internal_error', 'Google 图像为同步模型，不应轮询'));
  },
};
