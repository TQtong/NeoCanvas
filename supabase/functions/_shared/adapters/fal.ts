/**
 * fal.ai 队列适配器。
 *
 * 图片工具操作使用仓库内受控 Profile；普通生成/语义编辑在尚无固定 Schema 前失败关闭。
 * 外部任务号编码 endpoint，确保目录更新后历史任务仍能在原端点完成轮询。
 *
 * @module functions/_shared/adapters/fal
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
import { type ModelAdapter, type ModelContext } from './base.ts';

const QUEUE_BASE = 'https://queue.fal.run';
const FAL_INPAINT_ENDPOINT = 'fal-ai/inpaint';
const FAL_REMOVE_BACKGROUND_ENDPOINT = 'fal-ai/birefnet';
const FAL_UPSCALE_ENDPOINT = 'fal-ai/topaz/upscale/image';
const FAL_INPAINT_MODEL = 'diffusers/stable-diffusion-xl-1.0-inpainting-0.1';

/** fal 任务持久化句柄；不包含凭据、输入 URL 或提示词。 */
interface FalJobHandle {
  v: 1;
  endpoint: string;
  requestId: string;
  operation: ImageOperation | 'video';
}

/** fal 媒体对象的稳定子集。 */
interface FalMedia {
  url?: string;
  content_type?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/** 解析 fal 队列基址：优先用户自定义端点，否则默认。 */
function queueBase(ctx: ModelContext): string {
  return (ctx.credentials.baseUrl ?? QUEUE_BASE).replace(/\/$/, '');
}

/** 阻断 scheme、查询参数与路径穿越，避免模型目录把 endpoint 变成任意 URL。 */
function requireEndpoint(endpoint: string): string {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(endpoint) || endpoint.includes('..')) {
    throw new ApiException('model_unavailable', 'fal 模型 endpoint 配置无效');
  }
  return endpoint;
}

/** 编码历史任务可自描述的 fal 轮询句柄。 */
function encodeJobHandle(handle: FalJobHandle): string {
  return `fal:v1:${
    btoa(JSON.stringify(handle)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  }`;
}

/** 解码新句柄；旧任务号回退到当前模型 endpoint，兼容 v0.1 历史任务。 */
function decodeJobHandle(externalJobId: string, ctx: ModelContext): FalJobHandle {
  if (!externalJobId.startsWith('fal:v1:')) {
    return {
      v: 1,
      endpoint: requireEndpoint(ctx.providerModel),
      requestId: externalJobId,
      operation: 'video',
    };
  }
  try {
    const encoded = externalJobId.slice('fal:v1:'.length).replaceAll('-', '+').replaceAll('_', '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as FalJobHandle;
    if (parsed.v !== 1 || !parsed.requestId) throw new Error('invalid handle');
    return { ...parsed, endpoint: requireEndpoint(parsed.endpoint) };
  } catch {
    throw new ApiException('provider_error', 'fal 任务句柄无效');
  }
}

/** 取唯一角色输入；流水线已校验，适配器仍做纵深保护。 */
function requireReference(ctx: ModelContext, role: 'content' | 'mask') {
  const references = ctx.references.filter((reference) => reference.role === role);
  if (references.length !== 1) {
    throw new ApiException('invalid_params', `fal ${role} 输入数量必须为 1`);
  }
  return references[0];
}

/** 工具操作必须绑定对应目录 endpoint，目录不能扩大底层协议。 */
function requireToolEndpoint(ctx: ModelContext, expected: string): string {
  if (ctx.providerModel !== expected) {
    throw new ApiException('model_unavailable', 'fal 工具模型与操作 Profile 不匹配');
  }
  return expected;
}

/** 按操作构造 fal endpoint 与专用输入。 */
function buildImageInvocation(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
): { endpoint: string; operation: ImageOperation; input: Record<string, unknown> } {
  const params = request.params as ImageGenerationParams;
  const operation = normalizeImageOperation(params);
  const source = operation === 'generate' ? null : requireReference(ctx, 'content');

  switch (operation) {
    case 'inpaint': {
      const mask = requireReference(ctx, 'mask');
      return {
        endpoint: requireToolEndpoint(ctx, FAL_INPAINT_ENDPOINT),
        operation,
        input: {
          model_name: FAL_INPAINT_MODEL,
          prompt: request.prompt,
          image_url: source!.url,
          mask_url: mask.url,
          ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
          ...(params.seed != null ? { seed: params.seed } : {}),
        },
      };
    }
    case 'remove_background':
      return {
        endpoint: requireToolEndpoint(ctx, FAL_REMOVE_BACKGROUND_ENDPOINT),
        operation,
        input: {
          image_url: source!.url,
          output_format: 'png',
          output_mask: false,
          refine_foreground: true,
          sync_mode: false,
        },
      };
    case 'upscale':
      if (!('upscaleFactor' in params)) {
        throw new ApiException('invalid_params', 'fal 放大请求缺少 upscaleFactor');
      }
      return {
        endpoint: requireToolEndpoint(ctx, FAL_UPSCALE_ENDPOINT),
        operation,
        input: {
          image_url: source!.url,
          upscale_factor: params.upscaleFactor,
          model: 'Standard V2',
          output_format: 'png',
          crop_to_fill: false,
          face_enhancement: false,
        },
      };
    case 'outpaint':
      throw new ApiException('unsupported_param', 'fal 适配器未开放扩图操作');
    case 'semantic_edit':
    case 'generate':
      throw new ApiException('unsupported_param', `fal 未登记图片操作 Profile：${operation}`);
  }
}

/** 从 fal 单图或多图响应构建候选。 */
function imageCandidates(result: Record<string, unknown>) {
  const data = (result.data && typeof result.data === 'object' ? result.data : result) as Record<
    string,
    unknown
  >;
  const media: FalMedia[] = [];
  if (data.image && typeof data.image === 'object') media.push(data.image as FalMedia);
  if (Array.isArray(data.images)) media.push(...(data.images as FalMedia[]));
  return media
    .filter((item) => typeof item.url === 'string' && item.url.length > 0)
    .map((item) => ({
      kind: 'image' as const,
      mimeType: item.content_type ?? 'image/png',
      fetch: { type: 'url' as const, url: item.url! },
      width: item.width,
      height: item.height,
      sizeBytes: item.file_size,
      isEphemeral: true,
    }));
}

export const falAdapter: ModelAdapter = {
  provider: 'fal' as Provider,
  supportedOperations: ['inpaint', 'remove_background', 'upscale'],

  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    const invocation = request.modality === 'image' ? buildImageInvocation(request, ctx) : {
      endpoint: requireEndpoint(ctx.providerModel),
      operation: 'video' as const,
      input: { prompt: request.prompt },
    };
    const response = await fetch(`${queueBase(ctx)}/${invocation.endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${ctx.credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(invocation.input),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiException('provider_error', `fal 提交失败（${response.status}）`, {
        upstream: text.slice(0, 300),
      });
    }
    const json = (await response.json()) as { request_id?: string };
    if (!json.request_id) throw new ApiException('provider_error', 'fal 未返回请求号');
    return {
      kind: 'async',
      externalJobId: encodeJobHandle({
        v: 1,
        endpoint: invocation.endpoint,
        requestId: json.request_id,
        operation: invocation.operation,
      }),
      progress: 5,
    };
  },

  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const handle = decodeJobHandle(externalJobId, ctx);
    const headers = { Authorization: `Key ${ctx.credentials.apiKey}` };
    const requestBase = `${queueBase(ctx)}/${handle.endpoint}/requests/${handle.requestId}`;
    const statusRes = await fetch(`${requestBase}/status`, { headers });
    if (!statusRes.ok) {
      throw new ApiException('provider_error', `fal 状态查询失败（${statusRes.status}）`);
    }
    const status = (await statusRes.json()) as { status?: string; error?: string };
    if (status.status === 'FAILED' || status.status === 'CANCELLED') {
      return { status: 'failed', error: status.error ?? 'fal 任务失败' };
    }
    if (status.status !== 'COMPLETED') {
      return { status: 'running', progress: status.status === 'IN_PROGRESS' ? 60 : 20 };
    }

    const resultRes = await fetch(requestBase, { headers });
    if (!resultRes.ok) {
      throw new ApiException('provider_error', `fal 结果查询失败（${resultRes.status}）`);
    }
    const result = (await resultRes.json()) as Record<string, unknown>;
    const data = (result.data && typeof result.data === 'object' ? result.data : result) as Record<
      string,
      unknown
    >;
    const video = data.video as FalMedia | undefined;
    if (video?.url) {
      return {
        status: 'succeeded',
        candidates: [
          {
            kind: 'video',
            mimeType: video.content_type ?? 'video/mp4',
            fetch: { type: 'url', url: video.url },
            isEphemeral: true,
          },
        ],
      };
    }
    const candidates = imageCandidates(result);
    if (candidates.length === 0) return { status: 'failed', error: 'fal 未返回有效产出' };
    return { status: 'succeeded', candidates };
  },
};
