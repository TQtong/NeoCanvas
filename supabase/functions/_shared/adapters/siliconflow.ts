/**
 * 硅基流动（SiliconFlow）图像适配器（第 05 篇第三节）。
 *
 * 对接 SiliconFlow 的 OpenAI 风格图像生成接口 `/v1/images/generations`。与 OpenAI 图像
 * 接口的差异：请求用 `image_size`（"宽x高"）与 `batch_size`，响应为 `{ images: [{ url }] }`
 * 而非 `{ data: [{ b64_json | url }] }`。产出为带签名的临时 URL（约 1 小时有效），归一化为
 * 临时资产候选，由流水线取回转存到 Storage。
 *
 * 端点与密钥可经环境变量覆盖：`SILICONFLOW_BASE_URL`、`SILICONFLOW_API_KEY`。模型在
 * 提供商侧的 id 由 `model_catalog.default_params.providerModel` 给出（如 Kwai-Kolors/Kolors）。
 *
 * @module functions/_shared/adapters/siliconflow
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

/** 默认 API 根；可经 SILICONFLOW_BASE_URL 覆盖（OpenAI 兼容端点）。 */
const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';

/** 默认采样步数（文生图质量与耗时的折中）。 */
const DEFAULT_STEPS = 20;

/**
 * 把宽高映射到 SiliconFlow 文生图支持的 `image_size` 取值。
 *
 * 不同模型支持的尺寸集合不同；此处取各图像模型普遍支持的方/竖构图安全集，横构图退化为
 * 方图，避免触发提供商 invalid size 错误（第 05 篇第三节「能力差异在适配器内吸收」）。
 */
function toImageSize(width: number, height: number): string {
  if (height > width) return '768x1024';
  return '1024x1024';
}

export const siliconflowAdapter: ModelAdapter = {
  provider: 'siliconflow' as Provider,

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (request.modality !== 'image') {
      throw new ApiException('unsupported_param', 'SiliconFlow 适配器仅支持图像模态');
    }
    const apiKey = requireProviderKey('SILICONFLOW_API_KEY', 'siliconflow');
    const baseUrl = (Deno.env.get('SILICONFLOW_BASE_URL') ?? DEFAULT_BASE).replace(/\/$/, '');

    const params = request.params as ImageGenerationParams;
    const { width, height } = resolveSize(params);
    const count = Math.min(params.count || 1, ctx.capabilities.maxOutputs);

    const body: Record<string, unknown> = {
      model: ctx.providerModel,
      prompt: request.prompt,
      image_size: toImageSize(width, height),
      batch_size: count,
      num_inference_steps: DEFAULT_STEPS,
    };
    if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
    if (params.seed != null) body.seed = params.seed;
    // 图生图：把首个参考图以 base64 data URI 作为 `image` 注入（仅在模型声明支持参考图时到达此处）
    if (ctx.references.length > 0) {
      const ref = ctx.references[0];
      const { base64, mimeType } = await fetchReferenceBase64(ref);
      body.image = `data:${mimeType};base64,${base64}`;
    }

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `SiliconFlow 生成失败（${response.status}）`, {
        upstream: text.slice(0, 500),
      });
    }

    const json = (await response.json()) as { images?: Array<{ url?: string }> };
    const candidates = (json.images ?? [])
      .filter((item) => item.url)
      .map((item) => ({
        kind: 'image' as const,
        mimeType: 'image/png',
        // 临时签名 URL（约 1 小时有效），交由流水线尽快取回转存
        fetch: { type: 'url' as const, url: item.url as string },
        width,
        height,
        isEphemeral: true,
      }));

    if (candidates.length === 0) {
      throw new ApiException('provider_error', 'SiliconFlow 未返回任何图像');
    }
    return { kind: 'sync', candidates };
  },

  poll(): Promise<PollResult> {
    // 文生图为同步模型，无异步查询语义
    return Promise.reject(
      new ApiException('internal_error', 'SiliconFlow 图像为同步模型，不应轮询'),
    );
  },
};
