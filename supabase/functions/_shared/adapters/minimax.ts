/**
 * MiniMax 原生图片与视频模型适配器。
 *
 * 图片生成通过 `/image_generation` 同步返回图片 URL 或 base64；视频生成通过
 * `/video_generation` 创建异步任务，任务成功后再使用文件接口取得最终下载地址。
 * 具体模型 ID 由 `model_catalog.default_params.providerModel` 提供。
 *
 * @module functions/_shared/adapters/minimax
 */

import {
  type ImageGenerationParams,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
  type VideoGenerationParams,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { resolveSize, type ModelAdapter, type ModelContext } from './base.ts';

const DEFAULT_BASE = 'https://api.minimaxi.com/v1';

/** MiniMax 响应中所有接口共享的业务状态。 */
interface MiniMaxBaseResponse {
  status_code?: number;
  status_msg?: string;
}

/** 解析 MiniMax API 根地址，允许用户通过凭证设置覆盖官方默认端点。 */
function minimaxBase(ctx: ModelContext): string {
  return (ctx.credentials.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
}

/** 构造 MiniMax Bearer 鉴权请求头。 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * 检查 HTTP 200 响应中的 MiniMax 业务状态码。
 *
 * MiniMax 可能在 HTTP 请求成功时仍通过 `base_resp` 返回业务错误，因此不能只依赖
 * `Response.ok` 判断调用是否成功。
 */
function assertBusinessSuccess(
  baseResponse: MiniMaxBaseResponse | undefined,
  operation: string,
): void {
  if (baseResponse?.status_code != null && baseResponse.status_code !== 0) {
    throw new ApiException(
      'provider_error',
      `${operation}失败：${baseResponse.status_msg ?? `业务状态码 ${baseResponse.status_code}`}`,
    );
  }
}

/**
 * 读取失败响应并转换为统一的提供商异常。
 *
 * @param response - MiniMax HTTP 响应
 * @param operation - 用于错误消息的操作名称
 */
async function assertHttpSuccess(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const upstream = await response.text();
  throw new ApiException('provider_error', `${operation}失败（${response.status}）`, {
    upstream: upstream.slice(0, 500),
  });
}

/** 从 data URI 或原始 base64 字符串中提取可供资源归档使用的纯 base64 内容。 */
function normalizeBase64(value: string): string {
  const separator = value.indexOf(',');
  return value.startsWith('data:') && separator >= 0 ? value.slice(separator + 1) : value;
}

/** 提交 MiniMax 同步图片生成请求。 */
async function submitImage(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  apiKey: string,
  baseUrl: string,
): Promise<SubmitResult> {
  const params = request.params as ImageGenerationParams;
  const { width, height } = resolveSize(params);
  const body: Record<string, unknown> = {
    model: ctx.providerModel,
    prompt: request.prompt,
    aspect_ratio: params.aspectRatio ?? '1:1',
    response_format: 'url',
    n: Math.min(params.count || 1, ctx.capabilities.maxOutputs),
  };

  if (ctx.references.length > 0) {
    body.subject_reference = ctx.references.map((reference) => ({
      type: 'character',
      image_file: reference.url,
    }));
  }

  const response = await fetch(`${baseUrl}/image_generation`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  await assertHttpSuccess(response, 'MiniMax 图片生成');

  const json = (await response.json()) as {
    data?: { image_urls?: string[]; image_base64?: string[] };
    base_resp?: MiniMaxBaseResponse;
  };
  assertBusinessSuccess(json.base_resp, 'MiniMax 图片生成');

  const urlCandidates = (json.data?.image_urls ?? [])
    .filter((url) => typeof url === 'string' && url.length > 0)
    .map((url) => ({
      kind: 'image' as const,
      mimeType: 'image/jpeg',
      fetch: { type: 'url' as const, url },
      width,
      height,
      isEphemeral: true,
    }));
  const base64Candidates = (json.data?.image_base64 ?? [])
    .filter((data) => typeof data === 'string' && data.length > 0)
    .map((data) => ({
      kind: 'image' as const,
      mimeType: 'image/jpeg',
      fetch: { type: 'base64' as const, data: normalizeBase64(data) },
      width,
      height,
      isEphemeral: false,
    }));
  const candidates = [...urlCandidates, ...base64Candidates];

  if (candidates.length === 0) {
    throw new ApiException('provider_error', 'MiniMax 未返回任何图片');
  }
  return { kind: 'sync', candidates };
}

/** 提交 MiniMax 异步视频生成请求并返回任务 ID。 */
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
    duration: params.durationSec,
    resolution: params.resolution.toUpperCase(),
  };

  const firstFrame =
    ctx.keyframes[0] ??
    ctx.references.find((reference) => reference.role === 'first_frame') ??
    ctx.references[0];
  const lastFrame = ctx.keyframes.length > 1 ? ctx.keyframes[ctx.keyframes.length - 1] : undefined;
  if (firstFrame) body.first_frame_image = firstFrame.url;
  if (lastFrame) body.last_frame_image = lastFrame.url;

  const response = await fetch(`${baseUrl}/video_generation`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  await assertHttpSuccess(response, 'MiniMax 视频任务提交');

  const json = (await response.json()) as {
    task_id?: string;
    base_resp?: MiniMaxBaseResponse;
  };
  assertBusinessSuccess(json.base_resp, 'MiniMax 视频任务提交');
  if (!json.task_id) {
    throw new ApiException('provider_error', 'MiniMax 未返回视频任务 ID');
  }
  return { kind: 'async', externalJobId: json.task_id, progress: 5 };
}

/** 使用任务成功响应中的文件 ID 获取视频临时下载地址。 */
async function retrieveVideo(
  fileId: string,
  ctx: ModelContext,
): Promise<{ url: string; sizeBytes?: number }> {
  const response = await fetch(
    `${minimaxBase(ctx)}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    { headers: { Authorization: `Bearer ${ctx.credentials.apiKey}` } },
  );
  await assertHttpSuccess(response, 'MiniMax 视频文件获取');

  const json = (await response.json()) as {
    file?: { download_url?: string; bytes?: number };
    base_resp?: MiniMaxBaseResponse;
  };
  assertBusinessSuccess(json.base_resp, 'MiniMax 视频文件获取');
  if (!json.file?.download_url) {
    throw new ApiException('provider_error', 'MiniMax 视频任务成功但未返回下载地址');
  }
  return { url: json.file.download_url, sizeBytes: json.file.bytes };
}

/** MiniMax 原生图片与视频模型适配器。 */
export const minimaxAdapter: ModelAdapter = {
  provider: 'minimax' as Provider,

  /** 根据请求模态路由到 MiniMax 图片或视频原生接口。 */
  submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    const baseUrl = minimaxBase(ctx);
    const apiKey = ctx.credentials.apiKey;
    if (request.modality === 'image') return submitImage(request, ctx, apiKey, baseUrl);
    if (request.modality === 'video') return submitVideo(request, ctx, apiKey, baseUrl);
    return Promise.reject(new ApiException('unsupported_param', 'MiniMax 适配器仅支持图片 / 视频'));
  },

  /** 查询视频任务状态；成功时继续获取文件下载地址并归一化为视频候选。 */
  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const response = await fetch(
      `${minimaxBase(ctx)}/query/video_generation?task_id=${encodeURIComponent(externalJobId)}`,
      { headers: { Authorization: `Bearer ${ctx.credentials.apiKey}` } },
    );
    await assertHttpSuccess(response, 'MiniMax 视频任务查询');

    const json = (await response.json()) as {
      status?: string;
      file_id?: string;
      error_message?: string;
      base_resp?: MiniMaxBaseResponse;
    };
    assertBusinessSuccess(json.base_resp, 'MiniMax 视频任务查询');

    switch (json.status) {
      case 'Success': {
        if (!json.file_id) {
          return { status: 'failed', error: 'MiniMax 视频任务成功但未返回文件 ID' };
        }
        const file = await retrieveVideo(json.file_id, ctx);
        return {
          status: 'succeeded',
          candidates: [
            {
              kind: 'video',
              mimeType: 'video/mp4',
              fetch: { type: 'url', url: file.url },
              sizeBytes: file.sizeBytes,
              isEphemeral: true,
            },
          ],
        };
      }
      case 'Fail':
        return {
          status: 'failed',
          error: json.error_message ?? json.base_resp?.status_msg ?? 'MiniMax 视频任务失败',
        };
      case 'Processing':
        return { status: 'running', progress: 60 };
      case 'Queueing':
        return { status: 'running', progress: 25 };
      case 'Preparing':
      default:
        return { status: 'running', progress: 10 };
    }
  },
};
