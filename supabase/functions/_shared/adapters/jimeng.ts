/**
 * 即梦 AI 图片专业操作与视频模型适配器。
 *
 * 图片能力逐项绑定火山视觉官方 Action：图片 4.0、交互重绘、智能扩图、实体分割和图片
 * 超分辨率。目录中的 `providerModel` 只能选择本文件内置 Profile，不能注入任意 req_key 或
 * Action。视频暂时保留已上线的 2022-08-31 通用异步协议，避免破坏既有项目。
 *
 * @module functions/_shared/adapters/jimeng
 */

import {
  type AssetCandidate,
  type ImageGenerationParams,
  normalizeImageOperation,
  type OutpaintImageParams,
  type PollResult,
  type SemanticEditImageParams,
  type SubmitResult,
  type UnifiedGenerationRequest,
  type UpscaleImageParams,
  type VideoGenerationParams,
} from '../types.ts';
import { applyAlphaMask } from '../image.ts';
import { ApiException } from '../response.ts';
import {
  type ModelAdapter,
  type ModelContext,
  type ResolvedReference,
  resolveSize,
} from './base.ts';

/** 即梦智能视觉 API 官方根地址。 */
const DEFAULT_BASE_URL = 'https://visual.volcengineapi.com';
/** 图片专业 Action 使用的 API 版本。 */
const PRECISION_API_VERSION = '2024-06-06';
/** 既有视频通用异步协议版本。 */
const LEGACY_API_VERSION = '2022-08-31';
/** 智能视觉服务固定地域。 */
const REGION = 'cn-north-1';
/** 智能视觉服务固定服务名。 */
const SERVICE = 'cv';
/** 火山引擎签名算法名称。 */
const SIGNING_ALGORITHM = 'HMAC-SHA256';
/** 参与签名的请求头；顺序必须与规范化请求完全一致。 */
const SIGNED_HEADERS = 'host;x-content-sha256;x-date';
/** 火山视觉成功业务码。 */
const SUCCESS_CODE = 10000;
/** 新版异步句柄前缀，避免模型目录变更破坏在途任务。 */
const JOB_HANDLE_PREFIX = 'jimeng:v1:';

/** 图片目录 Profile，必须与迁移中的 providerModel 逐字一致。 */
const IMAGE_PROFILE = {
  generate: 'jimeng_t2i_v40',
  semantic_edit: 'jimeng_t2i_v40',
  inpaint: 'jimeng_image2image_dream_inpaint',
  outpaint: 'i2i_outpainting',
  remove_background: 'entity_seg',
  upscale: 'lens_nnsr2_pic_common',
} as const;

/** 即梦凭证 JSON 解码后的结构。 */
interface JimengCredential {
  /** 火山引擎 Access Key ID。 */
  accessKeyId: string;
  /** 火山引擎 Secret Access Key。 */
  secretAccessKey: string;
}

/** 火山视觉算法内部状态。 */
interface AlgorithmBaseResponse {
  /** `0` 表示算法执行成功。 */
  status_code?: number;
  /** 算法错误说明。 */
  status_message?: string;
}

/** 即梦提交、查询与同步处理接口共用的数据结构。 */
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
  /** 同步视觉算法的内部执行状态。 */
  algorithm_base_resp?: AlgorithmBaseResponse | null;
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

/** 写入 external_job_id 的受控异步路由。 */
interface JimengJobHandle {
  /** 句柄版本。 */
  v: 1;
  /** 提供商任务 ID。 */
  taskId: string;
  /** 对应 Profile 的官方查询 Action。 */
  pollAction: string;
  /** 对应查询 Action 的版本。 */
  version: string;
  /** 查询时必须原样携带的 req_key。 */
  reqKey: string;
}

/** 允许从持久化句柄调用的查询 Action 白名单。 */
const ALLOWED_POLL_ACTIONS = new Set([
  'JimengT2IV40GetResult',
  'JimengImage2ImageDreamInpaintGetResult',
  'CVSync2AsyncGetResult',
]);

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

/** 为火山视觉请求构造签名 V4 并发起 POST。 */
async function callJimeng(
  action: string,
  version: string,
  body: Record<string, unknown>,
  ctx: ModelContext,
): Promise<JimengResponse> {
  const credential = parseCredential(ctx.credentials.apiKey);
  const baseUrl = jimengBaseUrl(ctx);
  const query = canonicalQuery({ Action: action, Version: version });
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
      action,
    });
  }
  try {
    return JSON.parse(responseText) as JimengResponse;
  } catch {
    throw new ApiException('provider_error', '即梦接口返回了无法解析的响应', {
      upstream: responseText.slice(0, 500),
      action,
    });
  }
}

/** 校验 HTTP 200 内的业务码与算法内部码。 */
function assertSuccessfulResponse(response: JimengResponse, fallbackMessage: string): void {
  const algorithm = response.data?.algorithm_base_resp;
  if (response.code !== SUCCESS_CODE || (algorithm?.status_code ?? 0) !== 0) {
    throw new ApiException(
      'provider_error',
      algorithm?.status_message || response.message || fallbackMessage,
      {
        providerCode: response.code,
        algorithmCode: algorithm?.status_code,
        requestId: response.request_id,
      },
    );
  }
}

/** 把可能为单值或数组的响应字段归一化为非空字符串数组。 */
function normalizeStringList(value: string[] | string | null | undefined): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** 去除提供商偶尔附带的 data URI 头。 */
function stripDataUriPrefix(value: string): string {
  const match = value.match(/^data:[^;,]+;base64,(.*)$/s);
  return match?.[1] ?? value;
}

/** 安全地把字节数组编码为 base64，避免大图触发函数参数栈上限。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** 把 base64 解码为字节数组。 */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(stripDataUriPrefix(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 根据响应中的媒体字段构建统一产物候选。 */
function extractCandidates(data: JimengResponseData): AssetCandidate[] {
  const candidates: AssetCandidate[] = [
    ...normalizeStringList(data.image_urls).map((url) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      fetch: { type: 'url' as const, url },
      isEphemeral: true,
    })),
    ...normalizeStringList(data.binary_data_base64).map((base64) => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      fetch: { type: 'base64' as const, data: stripDataUriPrefix(base64) },
      isEphemeral: false,
    })),
  ];
  if (typeof data.video_url === 'string' && data.video_url.length > 0) {
    candidates.push({
      kind: 'video',
      mimeType: 'video/mp4',
      fetch: { type: 'url', url: data.video_url },
      isEphemeral: true,
    });
  }
  return candidates;
}

/** 取编辑请求中的源图；蒙版不参与源图选择。 */
function sourceReference(ctx: ModelContext): ResolvedReference {
  const reference = ctx.references.find((candidate) => candidate.role !== 'mask');
  if (!reference) throw new ApiException('invalid_params', '图片编辑缺少源资产');
  return reference;
}

/** 取重绘请求中的灰度蒙版。 */
function maskReference(ctx: ModelContext): ResolvedReference {
  const reference = ctx.references.find((candidate) => candidate.role === 'mask');
  if (!reference) throw new ApiException('invalid_params', '局部重绘缺少蒙版资产');
  return reference;
}

/** 校验目录模型没有借 providerModel 扩大适配器能力。 */
function requireImageProfile(operation: keyof typeof IMAGE_PROFILE, ctx: ModelContext): void {
  if (ctx.providerModel !== IMAGE_PROFILE[operation]) {
    throw new ApiException('model_unavailable', `即梦 ${operation} 模型未绑定受控 Profile`, {
      expectedProfile: IMAGE_PROFILE[operation],
    });
  }
}

/** 把受控异步路由编码为不含凭证和输入 URL 的 opaque handle。 */
function encodeJobHandle(handle: JimengJobHandle): string {
  return `${JOB_HANDLE_PREFIX}${bytesToBase64(new TextEncoder().encode(JSON.stringify(handle)))}`
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/** 解析新版句柄；历史裸 task id 返回 null，继续走旧协议兼容分支。 */
function decodeJobHandle(value: string): JimengJobHandle | null {
  if (!value.startsWith(JOB_HANDLE_PREFIX)) return null;
  try {
    const encoded = value.slice(JOB_HANDLE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(padded))) as Partial<
      JimengJobHandle
    >;
    if (
      parsed.v !== 1 ||
      typeof parsed.taskId !== 'string' ||
      typeof parsed.pollAction !== 'string' ||
      typeof parsed.version !== 'string' ||
      typeof parsed.reqKey !== 'string' ||
      !ALLOWED_POLL_ACTIONS.has(parsed.pollAction)
    ) {
      throw new Error('句柄字段无效');
    }
    return parsed as JimengJobHandle;
  } catch {
    throw new ApiException('provider_error', '即梦任务句柄损坏，无法继续查询');
  }
}

/** 从新版异步提交响应生成统一任务结果。 */
function asyncSubmitResult(
  response: JimengResponse,
  route: Omit<JimengJobHandle, 'v' | 'taskId'>,
): SubmitResult {
  assertSuccessfulResponse(response, '即梦任务提交失败');
  const taskId = response.data?.task_id;
  if (taskId == null || String(taskId).length === 0) {
    throw new ApiException('provider_error', '即梦提交成功但未返回任务 ID', {
      requestId: response.request_id,
    });
  }
  return {
    kind: 'async',
    externalJobId: encodeJobHandle({ v: 1, taskId: String(taskId), ...route }),
    progress: 5,
  };
}

/** 把图片 4.0 生成/语义编辑参数映射到官方异步 Action。 */
async function submitImageV4(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
  operation: 'generate' | 'semantic_edit',
): Promise<SubmitResult> {
  requireImageProfile(operation, ctx);
  const params = request.params as SemanticEditImageParams;
  const { width, height } = resolveSize(params, 2048);
  const body: Record<string, unknown> = {
    req_key: IMAGE_PROFILE[operation],
    prompt: request.prompt,
    width,
    height,
    force_single: Math.min(params.count || 1, ctx.capabilities.maxOutputs) === 1,
  };
  if (params.seed != null) body.seed = params.seed;
  if (operation === 'semantic_edit') {
    const references = ctx.references.filter((reference) => reference.role !== 'mask').slice(0, 10);
    if (references.length === 0) throw new ApiException('invalid_params', '语义编辑缺少源资产');
    body.image_urls = references.map((reference) => reference.url);
    body.scale = params.inputFidelity === 'high' ? 0.3 : 0.5;
  }
  const response = await callJimeng('JimengT2IV40SubmitTask', PRECISION_API_VERSION, body, ctx);
  return asyncSubmitResult(response, {
    pollAction: 'JimengT2IV40GetResult',
    version: PRECISION_API_VERSION,
    reqKey: IMAGE_PROFILE[operation],
  });
}

/** 把原图与蒙版按官方规定顺序提交至即梦交互重绘。 */
async function submitInpaint(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
): Promise<SubmitResult> {
  requireImageProfile('inpaint', ctx);
  const params = request.params as ImageGenerationParams;
  const source = sourceReference(ctx);
  const mask = maskReference(ctx);
  const body: Record<string, unknown> = {
    req_key: IMAGE_PROFILE.inpaint,
    image_urls: [source.url, mask.url],
    prompt: request.prompt,
  };
  if (params.seed != null) body.seed = params.seed;
  const response = await callJimeng(
    'JimengImage2ImageDreamInpaintSubmitTask',
    PRECISION_API_VERSION,
    body,
    ctx,
  );
  return asyncSubmitResult(response, {
    pollAction: 'JimengImage2ImageDreamInpaintGetResult',
    version: PRECISION_API_VERSION,
    reqKey: IMAGE_PROFILE.inpaint,
  });
}

/** 把 outputCanvas 换算为即梦四边扩展比例并同步取得扩图结果。 */
async function submitOutpaint(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
): Promise<SubmitResult> {
  requireImageProfile('outpaint', ctx);
  const params = request.params as OutpaintImageParams;
  const source = sourceReference(ctx);
  const canvas = params.outputCanvas;
  const ratios = {
    top: canvas.sourceY / canvas.sourceHeight,
    bottom: (canvas.height - canvas.sourceY - canvas.sourceHeight) / canvas.sourceHeight,
    left: canvas.sourceX / canvas.sourceWidth,
    right: (canvas.width - canvas.sourceX - canvas.sourceWidth) / canvas.sourceWidth,
  };
  if (Object.values(ratios).some((value) => value < 0 || value > 1)) {
    throw new ApiException(
      'unsupported_param',
      '即梦单次扩图每一边最多扩展原图对应边长的 1 倍，请缩小画布或改用其他模型',
    );
  }
  const body: Record<string, unknown> = {
    req_key: IMAGE_PROFILE.outpaint,
    image_urls: [source.url],
    custom_prompt: request.prompt,
    max_width: canvas.width,
    max_height: canvas.height,
    return_url: true,
  };
  for (const [side, ratio] of Object.entries(ratios)) {
    // 官方接口的合法区间是 (0, 1]，未扩展的边必须省略，不能传 0。
    if (ratio > 0) body[side] = Number(ratio.toFixed(6));
  }
  if (params.seed != null) body.seed = params.seed;
  const response = await callJimeng('Img2ImgOutpainting', PRECISION_API_VERSION, body, ctx);
  assertSuccessfulResponse(response, '即梦扩图失败');
  const candidates = extractCandidates(response.data ?? {});
  if (candidates.length === 0) throw new ApiException('provider_error', '即梦扩图未返回图片');
  return { kind: 'sync', candidates };
}

/** 取回 URL/base64 媒体字节。 */
async function fetchCandidateBytes(candidate: AssetCandidate): Promise<Uint8Array> {
  if (candidate.fetch.type === 'base64') return base64ToBytes(candidate.fetch.data);
  if (candidate.fetch.type === 'bytes') return candidate.fetch.bytes;
  const response = await fetch(candidate.fetch.url);
  if (!response.ok) {
    throw new ApiException('provider_error', `取回即梦分割图层失败（${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** 使用实体分割主体图层在 Edge 合成真正透明的 RGBA PNG。 */
async function submitRemoveBackground(ctx: ModelContext): Promise<SubmitResult> {
  requireImageProfile('remove_background', ctx);
  const source = sourceReference(ctx);
  const response = await callJimeng(
    'EntitySegment',
    PRECISION_API_VERSION,
    {
      req_key: IMAGE_PROFILE.remove_background,
      image_urls: [source.url],
      max_entity: 1,
      refine_mask: 1,
      // 原图 + 最主要实体图层，保证合成输入来自同一次服务端预处理。
      return_format: 3,
    },
    ctx,
  );
  assertSuccessfulResponse(response, '即梦主体分割失败');
  const layers = extractCandidates(response.data ?? {}).filter((candidate) =>
    candidate.kind === 'image'
  );
  if (layers.length < 2) {
    throw new ApiException('provider_error', '即梦主体分割未返回原图与主体蒙版');
  }
  try {
    const [sourceBytes, maskBytes] = await Promise.all([
      fetchCandidateBytes(layers[0]!),
      fetchCandidateBytes(layers[1]!),
    ]);
    const transparent = await applyAlphaMask(sourceBytes, maskBytes);
    return {
      kind: 'sync',
      candidates: [{
        kind: 'image',
        mimeType: 'image/png',
        fetch: { type: 'base64', data: bytesToBase64(transparent.bytes) },
        width: transparent.width,
        height: transparent.height,
        isEphemeral: false,
      }],
    };
  } catch (error) {
    if (error instanceof ApiException) throw error;
    throw new ApiException('provider_error', '即梦去背景透明图合成失败', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 取一个同步图片结果，并转为下一次超分可接受的输入字段。 */
function upscaleInput(data: JimengResponseData): {
  candidate: AssetCandidate;
  bodyInput: Record<string, unknown>;
} {
  const url = normalizeStringList(data.image_urls)[0];
  if (url) {
    return {
      candidate: {
        kind: 'image',
        mimeType: 'image/png',
        fetch: { type: 'url', url },
        isEphemeral: true,
      },
      bodyInput: { image_urls: [url] },
    };
  }
  const base64 = normalizeStringList(data.binary_data_base64)[0];
  if (base64) {
    const clean = stripDataUriPrefix(base64);
    return {
      candidate: {
        kind: 'image',
        mimeType: 'image/png',
        fetch: { type: 'base64', data: clean },
        isEphemeral: false,
      },
      bodyInput: { binary_data_base64: [clean] },
    };
  }
  throw new ApiException('provider_error', '即梦超分未返回图片');
}

/** 官方超分固定为 2×；4×请求通过两次受控 2× 串联实现。 */
async function submitUpscale(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
): Promise<SubmitResult> {
  requireImageProfile('upscale', ctx);
  const params = request.params as UpscaleImageParams;
  const source = sourceReference(ctx);
  let bodyInput: Record<string, unknown> = { image_urls: [source.url] };
  let finalCandidate: AssetCandidate | null = null;
  const passes = params.upscaleFactor / 2;
  for (let pass = 0; pass < passes; pass += 1) {
    const response = await callJimeng(
      'CVProcess',
      PRECISION_API_VERSION,
      {
        req_key: IMAGE_PROFILE.upscale,
        ...bodyInput,
        model_quality: params.quality === 'low' ? 'LQ' : 'HQ',
        result_format: 0,
        return_url: true,
      },
      ctx,
    );
    assertSuccessfulResponse(response, `即梦第 ${pass + 1} 次超分失败`);
    const output = upscaleInput(response.data ?? {});
    finalCandidate = output.candidate;
    bodyInput = output.bodyInput;
  }
  if (!finalCandidate) throw new ApiException('provider_error', '即梦超分未产生结果');
  return { kind: 'sync', candidates: [finalCandidate] };
}

/** 从 `720p`、`1080P` 等界面值中解析即梦接受的数值分辨率。 */
function parseResolution(value: string): number | undefined {
  const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 将既有视频参数映射为 2022 通用异步提交请求。 */
function buildLegacyVideoBody(
  request: UnifiedGenerationRequest,
  ctx: ModelContext,
): Record<string, unknown> {
  const params = request.params as VideoGenerationParams;
  const orderedReferences = ctx.keyframes.length > 0 ? ctx.keyframes : ctx.references;
  const body: Record<string, unknown> = {
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

/** 即梦图片专业操作与既有视频异步模型适配器。 */
export const jimengAdapter: ModelAdapter = {
  provider: 'jimeng',
  supportedOperations: [
    'generate',
    'semantic_edit',
    'inpaint',
    'outpaint',
    'remove_background',
    'upscale',
  ],

  /** 根据图片操作选择固定 Action；视频继续使用原有异步协议。 */
  async submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult> {
    if (!ctx.providerModel) {
      throw new ApiException('model_unavailable', '即梦模型缺少 providerModel 配置');
    }
    if (request.modality === 'video') {
      const response = await callJimeng(
        'CVSync2AsyncSubmitTask',
        LEGACY_API_VERSION,
        buildLegacyVideoBody(request, ctx),
        ctx,
      );
      return asyncSubmitResult(response, {
        pollAction: 'CVSync2AsyncGetResult',
        version: LEGACY_API_VERSION,
        reqKey: ctx.providerModel,
      });
    }
    if (request.modality !== 'image') {
      throw new ApiException('unsupported_param', '即梦适配器仅支持图片 / 视频生成');
    }

    const operation = normalizeImageOperation(request.params as ImageGenerationParams);
    if (operation === 'generate' || operation === 'semantic_edit') {
      return await submitImageV4(request, ctx, operation);
    }
    if (operation === 'inpaint') return await submitInpaint(request, ctx);
    if (operation === 'outpaint') return await submitOutpaint(request, ctx);
    if (operation === 'remove_background') return await submitRemoveBackground(ctx);
    return await submitUpscale(request, ctx);
  },

  /** 使用句柄冻结的查询 Action 轮询；历史裸任务 ID 保持兼容。 */
  async poll(externalJobId: string, ctx: ModelContext): Promise<PollResult> {
    const handle = decodeJobHandle(externalJobId) ?? {
      v: 1 as const,
      taskId: externalJobId,
      pollAction: 'CVSync2AsyncGetResult',
      version: LEGACY_API_VERSION,
      reqKey: ctx.providerModel,
    };
    const body: Record<string, unknown> = {
      req_key: handle.reqKey,
      task_id: handle.taskId,
    };
    if (handle.version === PRECISION_API_VERSION) {
      body.req_json = JSON.stringify({
        logo_info: { add_logo: false },
        return_url: true,
      });
    }
    const response = await callJimeng(handle.pollAction, handle.version, body, ctx);
    const data = response.data ?? {};
    const status = data.status?.toLowerCase();
    const algorithm = data.algorithm_base_resp;

    if (response.code !== SUCCESS_CODE || (algorithm?.status_code ?? 0) !== 0) {
      return {
        status: 'failed',
        error: algorithm?.status_message ||
          response.message ||
          `即梦任务失败（业务码 ${response.code ?? '未知'}）`,
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
