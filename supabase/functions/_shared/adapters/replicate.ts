/**
 * Replicate 受控 Profile 适配器。
 *
 * 精准编辑不接受任意版本与字段猜测。每个 Profile 固定 operation、模型版本、输入键和输出
 * 解析；旧视频模型仍保留 version-hash 通道，避免破坏既有非图片任务。
 *
 * @module functions/_shared/adapters/replicate
 */

import {
  type ImageGenerationParams,
  type ImageOperation,
  normalizeImageOperation,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { type ModelAdapter, type ModelContext, resolveSize } from './base.ts';

const API_BASE = 'https://api.replicate.com/v1';

/** 目录 `providerModel` 使用的稳定 Profile 标识。 */
export const REPLICATE_PROFILE_IDS = {
  inpaint: 'neocanvas:replicate:inpaint-sd2-v1',
  removeBackground: 'neocanvas:replicate:remove-background-v1',
  upscale: 'neocanvas:replicate:real-esrgan-v1',
} as const;

/** Profile 固定版本；更新必须伴随契约测试与新迁移。 */
const REPLICATE_PROFILES = {
  [REPLICATE_PROFILE_IDS.inpaint]: {
    operation: 'inpaint',
    version: '95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3',
  },
  [REPLICATE_PROFILE_IDS.removeBackground]: {
    operation: 'remove_background',
    version: 'a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc',
  },
  [REPLICATE_PROFILE_IDS.upscale]: {
    operation: 'upscale',
    version: 'b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8',
  },
} as const satisfies Record<
  string,
  {
    operation: Extract<ImageOperation, 'inpaint' | 'remove_background' | 'upscale'>;
    version: string;
  }
>;

type ReplicateProfile = (typeof REPLICATE_PROFILES)[keyof typeof REPLICATE_PROFILES];

/** 解析 Replicate 基址：优先用户自定义端点，否则默认。 */
function apiBase(ctx: ModelContext): string {
  return (ctx.credentials.baseUrl ?? API_BASE).replace(/\/$/, '');
}

/** 图片 Profile 必须由目录显式登记且 operation 精确一致。 */
function resolveProfile(providerModel: string, operation: ImageOperation): ReplicateProfile {
  const profile = (REPLICATE_PROFILES as Record<string, ReplicateProfile>)[providerModel];
  if (!profile || profile.operation !== operation) {
    throw new ApiException('model_unavailable', 'Replicate 图片模型未绑定受控操作 Profile');
  }
  return profile;
}

/** 取唯一角色输入，防止绕过流水线直接调用适配器。 */
function requireReference(ctx: ModelContext, role: 'content' | 'mask') {
  const references = ctx.references.filter((reference) => reference.role === role);
  if (references.length !== 1) {
    throw new ApiException('invalid_params', `Replicate ${role} 输入数量必须为 1`);
  }
  return references[0];
}

/** Stable Diffusion inpainting 尺寸必须是 64 的倍数。 */
function toDiffusionEdge(value: number): number {
  return Math.max(64, Math.min(2048, Math.round(value / 64) * 64));
}

/** 按受控 Profile 构造图片输入。 */
function buildProfileInput(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  operation: ImageOperation,
): Record<string, unknown> {
  const params = request.params as ImageGenerationParams;
  const source = requireReference(ctx, 'content');
  switch (operation) {
    case 'inpaint': {
      const mask = requireReference(ctx, 'mask');
      const { width, height } = resolveSize(params);
      return {
        image: source.url,
        mask: mask.url,
        prompt: request.prompt,
        width: toDiffusionEdge(width),
        height: toDiffusionEdge(height),
        num_outputs: Math.min(params.count || 1, ctx.capabilities.maxOutputs),
        ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
        ...(params.seed != null ? { seed: params.seed } : {}),
      };
    }
    case 'remove_background':
      return {
        image: source.url,
        format: 'png',
        background_type: 'rgba',
        threshold: 0,
        reverse: false,
      };
    case 'upscale':
      if (!('upscaleFactor' in params)) {
        throw new ApiException('invalid_params', 'Replicate 放大请求缺少 upscaleFactor');
      }
      return { image: source.url, scale: params.upscaleFactor, face_enhance: false };
    default:
      throw new ApiException('unsupported_param', `Replicate 未开放图片操作：${operation}`);
  }
}

/** 从字符串、数组和受控对象结构递归提取媒体 URL。 */
export function extractReplicateOutputUrls(output: unknown, depth = 0): string[] {
  if (depth > 6 || output == null) return [];
  if (typeof output === 'string') return /^https?:\/\//.test(output) ? [output] : [];
  if (Array.isArray(output)) {
    return output.flatMap((item) => extractReplicateOutputUrls(item, depth + 1));
  }
  if (typeof output !== 'object') return [];
  const record = output as Record<string, unknown>;
  const keys = ['url', 'image', 'images', 'output'];
  return keys.flatMap((key) => extractReplicateOutputUrls(record[key], depth + 1));
}

export const replicateAdapter: ModelAdapter = {
  provider: 'replicate' as Provider,
  supportedOperations: ['inpaint', 'remove_background', 'upscale'],

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    let version = ctx.providerModel;
    let input: Record<string, unknown> = { prompt: request.prompt };
    if (request.modality === 'image') {
      const params = request.params as ImageGenerationParams;
      const operation = normalizeImageOperation(params);
      const profile = resolveProfile(ctx.providerModel, operation);
      version = profile.version;
      input = buildProfileInput(request, ctx, operation);
    }

    const response = await fetch(`${apiBase(ctx)}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.credentials.apiKey}`,
        'Content-Type': 'application/json',
        'Cancel-After': '15m',
      },
      body: JSON.stringify({ version, input }),
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
    const response = await fetch(`${apiBase(ctx)}/predictions/${externalJobId}`, {
      headers: { Authorization: `Bearer ${ctx.credentials.apiKey}` },
    });
    if (!response.ok) {
      throw new ApiException('provider_error', `Replicate 查询失败（${response.status}）`);
    }
    const json = (await response.json()) as {
      status?: string;
      output?: unknown;
      error?: string;
    };

    if (json.status === 'succeeded') {
      const candidates = extractReplicateOutputUrls(json.output).map((url) => ({
        kind: 'image' as const,
        mimeType: 'image/png',
        fetch: { type: 'url' as const, url },
        isEphemeral: true,
      }));
      if (candidates.length === 0) return { status: 'failed', error: 'Replicate 未返回有效产出' };
      return { status: 'succeeded', candidates };
    }
    if (json.status === 'failed' || json.status === 'canceled') {
      return { status: 'failed', error: json.error ?? 'Replicate 任务失败' };
    }
    return { status: 'running', progress: json.status === 'processing' ? 60 : 20 };
  },
};
