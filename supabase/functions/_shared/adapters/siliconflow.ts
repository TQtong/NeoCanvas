/**
 * 硅基流动（SiliconFlow）图片 / 视频模型适配器。
 *
 * 图片调用同步接口 `/images/generations`；视频调用异步接口 `/video/submit`，随后通过
 * `/video/status` 轮询。具体模型 ID 由 `model_catalog.default_params.providerModel` 提供。
 *
 * @module functions/_shared/adapters/siliconflow
 */

import {
  type ImageGenerationParams,
  normalizeImageOperation,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
  type VideoGenerationParams,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { fetchReferenceBase64, type ModelAdapter, type ModelContext, resolveSize } from './base.ts';

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';
const DEFAULT_STEPS = 20;
const QWEN_IMAGE_EDIT = 'Qwen/Qwen-Image-Edit';
const QWEN_IMAGE_EDIT_2509 = 'Qwen/Qwen-Image-Edit-2509';
const VERIFIED_EDIT_MODELS = new Set([QWEN_IMAGE_EDIT, QWEN_IMAGE_EDIT_2509]);

/** 解析 API 根地址：优先使用用户自定义端点。 */
function siliconflowBase(ctx: ModelContext): string {
  return (ctx.credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
}

/** 将画布尺寸映射到 SiliconFlow 图片接口的稳定尺寸。 */
function toImageSize(providerModel: string, width: number, height: number): string {
  const ratio = width / height;
  if (providerModel === 'Qwen/Qwen-Image') {
    if (ratio > 1.55) return '1664x928';
    if (ratio > 1.18) return '1472x1140';
    if (ratio < 0.65) return '928x1664';
    if (ratio < 0.85) return '1140x1472';
    return '1328x1328';
  }
  if (ratio > 1.1) return '1024x768';
  if (ratio < 0.9) return '768x1024';
  return '1024x1024';
}

/** 将视频比例映射到 Wan 2.2 支持的官方尺寸。 */
function toVideoSize(aspectRatio?: string): string {
  if (aspectRatio === '9:16') return '720x1280';
  if (aspectRatio === '1:1') return '960x960';
  return '1280x720';
}

/** 把参考图编码为 SiliconFlow 接受的 data URI。 */
async function referenceDataUri(
  reference: ModelContext['references'][number],
): Promise<string> {
  const { base64, mimeType } = await fetchReferenceBase64(reference);
  return `data:${mimeType};base64,${base64}`;
}

/** 把首张参考图编码为 SiliconFlow 接受的 data URI。 */
function firstReferenceDataUri(ctx: ModelContext): Promise<string | null> {
  const reference = ctx.references[0];
  return reference ? referenceDataUri(reference) : Promise.resolve(null);
}

/** 提交同步图片生成 / 编辑请求。 */
async function submitImage(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  apiKey: string,
  baseUrl: string,
): Promise<SubmitResult> {
  const params = request.params as ImageGenerationParams;
  const operation = normalizeImageOperation(params);
  const { width, height } = resolveSize(params);
  const count = Math.min(params.count || 1, ctx.capabilities.maxOutputs);
  const body: Record<string, unknown> = {
    model: ctx.providerModel,
    prompt: request.prompt,
    num_inference_steps: DEFAULT_STEPS,
  };
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (params.seed != null) body.seed = params.seed;

  if (operation === 'semantic_edit') {
    if (!VERIFIED_EDIT_MODELS.has(ctx.providerModel)) {
      throw new ApiException(
        'unsupported_param',
        'SiliconFlow 只有已验证的 Qwen Image Edit 模型支持语义编辑',
      );
    }
    const contentReferences = ctx.references.filter((reference) => reference.role === 'content');
    const styleReferences = ctx.references.filter((reference) => reference.role === 'style');
    const hasUnsupportedRole = ctx.references.some(
      (reference) => reference.role !== 'content' && reference.role !== 'style',
    );
    const maxStyles = ctx.providerModel === QWEN_IMAGE_EDIT_2509 ? 2 : 0;
    if (
      contentReferences.length !== 1 ||
      hasUnsupportedRole ||
      styleReferences.length > maxStyles ||
      ctx.references.length !== contentReferences.length + styleReferences.length
    ) {
      throw new ApiException(
        'unsupported_param',
        ctx.providerModel === QWEN_IMAGE_EDIT_2509
          ? 'Qwen Image Edit 2509 必须包含一个内容源图，且最多追加两个风格参考图'
          : 'Qwen Image Edit 必须包含且仅包含一个内容源图',
      );
    }
    body.image = await referenceDataUri(contentReferences[0]!);
    if (styleReferences[0]) body.image2 = await referenceDataUri(styleReferences[0]);
    if (styleReferences[1]) body.image3 = await referenceDataUri(styleReferences[1]);
  } else if (operation === 'generate') {
    if (VERIFIED_EDIT_MODELS.has(ctx.providerModel)) {
      throw new ApiException('unsupported_param', 'Qwen Image Edit 模型不能用于普通文生图入口');
    }
    if (ctx.references.length > 0) {
      throw new ApiException('unsupported_param', 'SiliconFlow 普通生成模型不能携带编辑源图');
    }
    body.image_size = toImageSize(ctx.providerModel, width, height);
    // 官方 batch_size 仅适用于 Kolors；其他模型单次固定返回一张。
    if (ctx.providerModel === 'Kwai-Kolors/Kolors') body.batch_size = count;
  } else {
    throw new ApiException('unsupported_param', `SiliconFlow 不支持图片操作 ${operation}`);
  }

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiException('provider_error', `SiliconFlow 图片生成失败（${response.status}）`, {
      upstream: text.slice(0, 500),
    });
  }

  const json = (await response.json()) as { images?: Array<{ url?: string }> };
  const candidates = (json.images ?? [])
    .filter((item): item is { url: string } => Boolean(item.url))
    .map((item) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      fetch: { type: 'url' as const, url: item.url },
      width,
      height,
      isEphemeral: true,
    }));
  if (candidates.length === 0) {
    throw new ApiException('provider_error', 'SiliconFlow 未返回任何图片');
  }
  return { kind: 'sync', candidates };
}

/** 提交 Wan 2.2 视频生成请求，返回异步任务号。 */
async function submitVideo(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  apiKey: string,
  baseUrl: string,
): Promise<SubmitResult> {
  const params = request.params as VideoGenerationParams;
  const body: Record<string, unknown> = {
    model: ctx.providerModel,
    prompt: request.prompt,
    image_size: toVideoSize(params.aspectRatio),
  };
  if (params.seed != null) body.seed = params.seed;
  const reference = await firstReferenceDataUri(ctx);
  if (reference) body.image = reference;

  const response = await fetch(`${baseUrl}/video/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiException('provider_error', `SiliconFlow 视频提交失败（${response.status}）`, {
      upstream: text.slice(0, 500),
    });
  }

  const json = (await response.json()) as { requestId?: string };
  if (!json.requestId) {
    throw new ApiException('provider_error', 'SiliconFlow 未返回视频任务号');
  }
  return { kind: 'async', externalJobId: json.requestId, progress: 5 };
}

export const siliconflowAdapter: ModelAdapter = {
  provider: 'siliconflow' as Provider,
  supportedOperations: ['generate', 'semantic_edit'],

  submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    const apiKey = ctx.credentials.apiKey;
    const baseUrl = siliconflowBase(ctx);
    if (request.modality === 'image') return submitImage(request, ctx, apiKey, baseUrl);
    if (request.modality === 'video') return submitVideo(request, ctx, apiKey, baseUrl);
    return Promise.reject(
      new ApiException('unsupported_param', 'SiliconFlow 适配器仅支持图片 / 视频'),
    );
  },

  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const response = await fetch(`${siliconflowBase(ctx)}/video/status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requestId: externalJobId }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `SiliconFlow 视频查询失败（${response.status}）`, {
        upstream: text.slice(0, 500),
      });
    }

    const json = (await response.json()) as {
      status?: string;
      reason?: string;
      results?: { videos?: Array<{ url?: string }> };
    };
    switch (json.status) {
      case 'Succeed': {
        const url = json.results?.videos?.find((video) => video.url)?.url;
        if (!url) return { status: 'failed', error: 'SiliconFlow 成功但未返回视频地址' };
        return {
          status: 'succeeded',
          candidates: [
            {
              kind: 'video',
              mimeType: 'video/mp4',
              fetch: { type: 'url', url },
              isEphemeral: true,
            },
          ],
        };
      }
      case 'Failed':
        return { status: 'failed', error: json.reason ?? 'SiliconFlow 视频任务失败' };
      case 'InProgress':
        return { status: 'running', progress: 60 };
      case 'InQueue':
      default:
        return { status: 'running', progress: 20 };
    }
  },
};
