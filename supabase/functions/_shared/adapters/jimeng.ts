/**
 * 即梦 AI 原生图片 / 视频模型适配器。
 *
 * 即梦智能视觉 API 使用火山引擎签名 V4 鉴权。图片和视频均通过
 * `CVSync2AsyncSubmitTask` 提交异步任务，再通过 `CVSync2AsyncGetResult` 轮询；具体能力由
 * `model_catalog.default_params.providerModel` 中的 `req_key` 决定。用户凭证以 JSON 字符串
 * `{ "accessKeyId": "...", "secretAccessKey": "..." }` 存储在统一凭证字段中。
 *
 * @module functions/_shared/adapters/jimeng
 */

import {
  type AssetCandidate,
  type ImageGenerationParams,
  type PollResult,
  type SubmitResult,
  type UnifiedGenerationRequest,
  type VideoGenerationParams,
} from '../types.ts';
import { ApiException } from '../response.ts';
import { type ModelAdapter, type ModelContext, resolveSize } from './base.ts';

/** 即梦智能视觉 API 的官方根地址。 */
const DEFAULT_BASE_URL = 'https://visual.volcengineapi.com';
/** 即梦异步接口的固定版本。 */
const API_VERSION = '2022-08-31';
/** 智能视觉服务固定地域。 */
const REGION = 'cn-north-1';
/** 智能视觉服务固定服务名。 */
const SERVICE = 'cv';
/** 火山引擎签名算法名称。 */
const SIGNING_ALGORITHM = 'HMAC-SHA256';
/** 参与签名的请求头；顺序必须与规范化请求完全一致。 */
const SIGNED_HEADERS = 'host;x-content-sha256;x-date';
/** 火山引擎成功业务码。 */
const SUCCESS_CODE = 10000;

/** 即梦凭证 JSON 解码后的结构。 */
interface JimengCredential {
  /** 火山引擎 Access Key ID。 */
  accessKeyId: string;
  /** 火山引擎 Secret Access Key。 */
  secretAccessKey: string;
}

/** 即梦通用业务响应。 */
interface JimengResponse {
  /** 业务状态码，`10000` 表示请求成功。 */
  code?: number;
  /** 面向调用方的业务消息。 */
  message?: string;
  /** 排障用请求 ID。 */
  request_id?: string;
  /** 不同 Action 返回的业务数据。 */
  data?: JimengResponseData | null;
}

/** 即梦提交与查询接口共用的数据结构。 */
interface JimengResponseData {
  /** 提交成功后的异步任务 ID。 */
  task_id?: string | number;
  /** 异步任务状态。 */
  status?: string;
  /** 图片临时 URL 列表。 */
  image_urls?: string[] | string | null;
  /** 图片 base64 列表。 */
  binary_data_base64?: string[] | string | null;
  /** 视频临时 URL。 */
  video_url?: string | null;
}

/** 即梦提交接口请求体。 */
interface JimengSubmitBody {
  /** 即梦服务标识，由 `providerModel` 提供。 */
  req_key: string;
  /** 图片 / 视频提示词。 */
  prompt: string;
  /** 参考图 URL，图片编辑、图生视频及首尾帧模型使用。 */
  image_urls?: string[];
  /** 图片输出宽度。 */
  width?: number;
  /** 图片输出高度。 */
  height?: number;
  /** 是否强制图片模型只生成一张图片。 */
  force_single?: boolean;
  /** 随机种子。 */
  seed?: number;
  /** 视频输出比例。 */
  aspect_ratio?: string;
  /** 视频分辨率的短边数值。 */
  resolution?: number;
  /** 视频总帧数，按即梦固定 24 FPS 换算。 */
  frames?: number;
}

/** 即梦查询接口请求体。 */
interface JimengPollBody {
  /** 即梦服务标识，由 `providerModel` 提供。 */
  req_key: string;
  /** 提交接口返回的异步任务 ID。 */
  task_id: string;
}

/** 把字节数组编码为小写十六进制字符串。 */
function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 计算 UTF-8 文本的 SHA-256 十六进制摘要。 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(digest);
}

/** 使用 HMAC-SHA256 对 UTF-8 文本签名，并返回原始字节。 */
async function hmacSha256(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  // 显式复制到 ArrayBuffer，兼容新版 TypeScript 对 WebCrypto BufferSource 的严格类型检查。
  const keyBuffer = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyBuffer).set(keyBytes);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

/** 按 RFC 3986 编码查询参数的名称或取值。 */
function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 生成按 ASCII 名称排序的规范化查询字符串。 */
function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, value]) => `${encodeQueryComponent(name)}=${encodeQueryComponent(value)}`)
    .join('&');
}

/** 把时间格式化为火山引擎要求的 UTC `YYYYMMDDTHHMMSSZ`。 */
function formatRequestDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** 从统一凭证字段解析并校验即梦 AK/SK。 */
function parseCredential(rawCredential: string): JimengCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCredential);
  } catch {
    throw new ApiException(
      'invalid_params',
      '即梦凭证格式无效，请填写包含 accessKeyId 和 secretAccessKey 的 JSON',
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ApiException(
      'invalid_params',
      '即梦凭证格式无效，请填写包含 accessKeyId 和 secretAccessKey 的 JSON',
    );
  }
  const credential = parsed as Record<string, unknown>;
  const accessKeyId = typeof credential.accessKeyId === 'string'
    ? credential.accessKeyId.trim()
    : '';
  const secretAccessKey = typeof credential.secretAccessKey === 'string'
    ? credential.secretAccessKey.trim()
    : '';
  if (!accessKeyId || !secretAccessKey) {
    throw new ApiException('invalid_params', '即梦凭证缺少 accessKeyId 或 secretAccessKey');
  }
  return { accessKeyId, secretAccessKey };
}

/** 解析智能视觉 API 根地址，允许统一凭证中的用户端点覆盖官方默认值。 */
function jimengBaseUrl(ctx: ModelContext): URL {
  const rawBaseUrl = (ctx.credentials.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new ApiException('invalid_params', '即梦 API 端点不是有效 URL');
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new ApiException('invalid_params', '即梦 API 端点必须使用 HTTP 或 HTTPS');
  }
  return baseUrl;
}

/**
 * 为即梦智能视觉请求构造火山引擎 V4 签名并发起 POST。
 *
 * @param action - 即梦异步 Action
 * @param body - 已序列化前的 JSON 请求体
 * @param ctx - 模型调用上下文
 * @returns 已解析的即梦业务响应
 */
async function callJimeng(
  action: 'CVSync2AsyncSubmitTask' | 'CVSync2AsyncGetResult',
  body: JimengSubmitBody | JimengPollBody,
  ctx: ModelContext,
): Promise<JimengResponse> {
  const credential = parseCredential(ctx.credentials.apiKey);
  const baseUrl = jimengBaseUrl(ctx);
  const query = canonicalQuery({ Action: action, Version: API_VERSION });
  const endpoint = new URL(baseUrl.toString());
  endpoint.search = query;

  const requestBody = JSON.stringify(body);
  const payloadHash = await sha256Hex(requestBody);
  const requestDate = formatRequestDate(new Date());
  const shortDate = requestDate.slice(0, 8);
  const canonicalPath = endpoint.pathname || '/';
  const canonicalHeaders = [
    `host:${endpoint.host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${requestDate}`,
  ].join('\n');
  const canonicalRequest = [
    'POST',
    canonicalPath,
    query,
    canonicalHeaders,
    '',
    SIGNED_HEADERS,
    payloadHash,
  ].join('\n');
  const credentialScope = `${shortDate}/${REGION}/${SERVICE}/request`;
  const stringToSign = [
    SIGNING_ALGORITHM,
    requestDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const dateKey = await hmacSha256(credential.secretAccessKey, shortDate);
  const regionKey = await hmacSha256(dateKey, REGION);
  const serviceKey = await hmacSha256(regionKey, SERVICE);
  const signingKey = await hmacSha256(serviceKey, 'request');
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  const authorization =
    `${SIGNING_ALGORITHM} Credential=${credential.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      'X-Content-Sha256': payloadHash,
      'X-Date': requestDate,
    },
    body: requestBody,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new ApiException('provider_error', `即梦接口请求失败（${response.status}）`, {
      upstream: responseText.slice(0, 500),
    });
  }

  try {
    return JSON.parse(responseText) as JimengResponse;
  } catch {
    throw new ApiException('provider_error', '即梦接口返回了无法解析的响应', {
      upstream: responseText.slice(0, 500),
    });
  }
}

/** 将图片生成参数映射为即梦异步提交请求。 */
function buildImageBody(request: UnifiedGenerationRequest, ctx: ModelContext): JimengSubmitBody {
  const params = request.params as ImageGenerationParams;
  const { width, height } = resolveSize(params, 2048);
  const body: JimengSubmitBody = {
    req_key: ctx.providerModel,
    prompt: request.prompt,
    width,
    height,
    force_single: Math.min(params.count || 1, ctx.capabilities.maxOutputs) === 1,
  };
  if (params.seed != null) body.seed = params.seed;
  if (ctx.references.length > 0) {
    body.image_urls = ctx.references.map((reference) => reference.url).slice(0, 10);
  }
  return body;
}

/** 从 `720p`、`1080P` 等界面值中解析即梦接受的数值分辨率。 */
function parseResolution(value: string): number | undefined {
  const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 将视频生成参数映射为即梦异步提交请求。 */
function buildVideoBody(request: UnifiedGenerationRequest, ctx: ModelContext): JimengSubmitBody {
  const params = request.params as VideoGenerationParams;
  const orderedReferences = ctx.keyframes.length > 0 ? ctx.keyframes : ctx.references;
  const body: JimengSubmitBody = {
    req_key: ctx.providerModel,
    prompt: request.prompt,
    frames: Math.round(params.durationSec * 24) + 1,
  };
  if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
  const resolution = parseResolution(params.resolution);
  if (resolution) body.resolution = resolution;
  if (params.seed != null) body.seed = params.seed;
  if (orderedReferences.length > 0) {
    body.image_urls = orderedReferences.map((reference) => reference.url);
  }
  return body;
}

/** 把可能为单值或数组的响应字段归一化为非空字符串数组。 */
function normalizeStringList(value: string[] | string | null | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 去除提供商偶尔附带的 data URI 头，只保留统一产物契约要求的 base64 内容。 */
function stripDataUriPrefix(value: string): string {
  const match = value.match(/^data:[^;,]+;base64,(.*)$/s);
  return match?.[1] ?? value;
}

/** 根据轮询响应中的媒体字段构建统一产物候选。 */
function extractCandidates(data: JimengResponseData): AssetCandidate[] {
  const imageUrls = normalizeStringList(data.image_urls);
  const imageBase64 = normalizeStringList(data.binary_data_base64);
  const candidates: AssetCandidate[] = [
    ...imageUrls.map((url) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      fetch: { type: 'url' as const, url },
      isEphemeral: true,
    })),
    ...imageBase64.map((base64) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      fetch: { type: 'base64' as const, data: stripDataUriPrefix(base64) },
      isEphemeral: false,
    })),
  ];
  if (typeof data.video_url === 'string' && data.video_url.length > 0) {
    candidates.push({
      kind: 'video' as const,
      mimeType: 'video/mp4',
      fetch: { type: 'url' as const, url: data.video_url },
      isEphemeral: true,
    });
  }
  return candidates;
}

/** 即梦原生图片 / 视频异步模型适配器。 */
export const jimengAdapter: ModelAdapter = {
  provider: 'jimeng',

  /** 提交图片或视频异步任务并返回即梦任务 ID。 */
  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (request.modality !== 'image' && request.modality !== 'video') {
      throw new ApiException('unsupported_param', '即梦适配器仅支持图片 / 视频生成');
    }
    if (!ctx.providerModel) {
      throw new ApiException('model_unavailable', '即梦模型缺少 req_key 配置');
    }

    const body = request.modality === 'image'
      ? buildImageBody(request, ctx)
      : buildVideoBody(request, ctx);
    const response = await callJimeng('CVSync2AsyncSubmitTask', body, ctx);
    if (response.code !== SUCCESS_CODE) {
      throw new ApiException('provider_error', response.message ?? '即梦任务提交失败', {
        providerCode: response.code,
        requestId: response.request_id,
      });
    }
    const taskId = response.data?.task_id;
    if (taskId == null || String(taskId).length === 0) {
      throw new ApiException('provider_error', '即梦提交成功但未返回任务 ID', {
        requestId: response.request_id,
      });
    }
    return { kind: 'async', externalJobId: String(taskId), progress: 5 };
  },

  /** 查询即梦异步任务，并把图片、base64 或视频结果归一化为统一候选。 */
  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const response = await callJimeng(
      'CVSync2AsyncGetResult',
      { req_key: ctx.providerModel, task_id: externalJobId },
      ctx,
    );
    const data = response.data ?? {};
    const status = data.status?.toLowerCase();

    if (response.code !== SUCCESS_CODE) {
      return {
        status: 'failed',
        error: response.message ?? `即梦任务失败（业务码 ${response.code ?? '未知'}）`,
      };
    }
    if (status === 'in_queue') return { status: 'running', progress: 20 };
    if (status === 'generating') return { status: 'running', progress: 60 };
    if (status === 'not_found') return { status: 'failed', error: '即梦任务不存在或已被清理' };
    if (status === 'expired') return { status: 'failed', error: '即梦任务已过期，请重新提交' };

    const candidates = extractCandidates(data);
    if (status === 'done' || candidates.length > 0) {
      return candidates.length > 0
        ? { status: 'succeeded', candidates }
        : { status: 'failed', error: response.message ?? '即梦任务完成但未返回媒体结果' };
    }
    return { status: 'running', progress: 20 };
  },
};
