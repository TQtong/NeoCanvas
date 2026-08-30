/**
 * 模型适配器抽象（第 05 篇第二节）。
 *
 * 每个外部模型 / 提供商被封装为实现统一接口的适配器，对上暴露提交 / 查询 / 能力画像三组
 * 语义；编排层只依赖该接口，不感知具体提供商。归一化（normalize）的产出为
 * {@link AssetCandidate}，由完成阶段统一取回转存。
 *
 * @module functions/_shared/adapters/base
 */

import {
  type ImageOperation,
  type ModelCapabilities,
  type PollResult,
  type Provider,
  type SubmitResult,
  type UnifiedGenerationRequest,
} from '../types.ts';
import { ApiException } from '../response.ts';

/** 解析后的参考素材：已取得签名 URL 与 MIME，供适配器直接取回。 */
export interface ResolvedReference {
  assetId: string;
  role: 'style' | 'content' | 'first_frame' | 'mask' | 'keyframe';
  url: string;
  mimeType: string;
}

/** 适配器调用上下文。 */
export interface ModelContext {
  /** 模型键。 */
  modelKey: string;
  /** 模型能力画像（来自 model_catalog）。 */
  capabilities: ModelCapabilities;
  /** 模型在提供商侧的端点 / 模型 id（来自 default_params.providerModel 或环境变量）。 */
  providerModel: string;
  /** 已解析的参考素材（无序，单首帧 / 风格 / 内容参考）。 */
  references: ResolvedReference[];
  /**
   * 已解析的有序关键帧（「逐段首尾帧」视频合成）。按用户在画布上连接的 `sequence` 链方向
   * 排列，相邻两帧构成一段（前者首帧、后者尾帧）。仅视频图生视频模型消费；非序列请求为空数组。
   */
  keyframes: ResolvedReference[];
  /**
   * 已解析的提供商凭证（BYOK）。由 {@link import('../credentials.ts').resolveProviderCredential}
   * 在构建上下文时解析：优先取请求归属用户在该 provider 的启用凭证（Vault 解密），无则回退
   * 环境变量。适配器只从此处取 Key / 端点，**不再各自读 `Deno.env`**（密钥解析单点化）。
   */
  credentials: { apiKey: string; baseUrl?: string };
  /**
   * 仅对声明支持回调的异步模型提供。适配器应把 url 与 secret 写入 Provider 的回调参数；
   * secret 只存在于本次提交内存，数据库仅保存其 SHA-256。
   */
  webhookCallback?: { url: string; secret: string; expiresAt: string };
}

/** 模型适配器统一接口。 */
export interface ModelAdapter {
  /** 提供商标识。 */
  readonly provider: Provider;
  /** 适配器当前具有完整请求映射和响应校验的图片操作。 */
  readonly supportedOperations: readonly ImageOperation[];
  /** 提交一次生成。 */
  submit(request: UnifiedGenerationRequest, ctx: ModelContext): Promise<SubmitResult>;
  /** 查询一次异步生成的状态与进度。 */
  poll(externalJobId: string, ctx: ModelContext): Promise<PollResult>;
}

/**
 * 把比例与显式尺寸归一为「宽×高」像素。优先显式尺寸，其次按比例配合基准边长推导。
 *
 * @param params - 含 aspectRatio / width / height 的图像参数
 * @param base - 基准边长（px）
 * @returns 宽高像素
 */
export function resolveSize(
  params: { aspectRatio?: string; width?: number; height?: number },
  base = 1024,
): { width: number; height: number } {
  if (params.width && params.height) {
    return { width: params.width, height: params.height };
  }
  const ratio = params.aspectRatio ?? '1:1';
  const [w, h] = ratio.split(':').map((n) => Number(n));
  const rw = w || 1;
  const rh = h || 1;
  if (rw >= rh) {
    return { width: base, height: Math.round((base * rh) / rw) };
  }
  return { width: Math.round((base * rw) / rh), height: base };
}

/** 把签名 URL 的参考图取回为 base64（供需要内联图像的提供商使用）。 */
export async function fetchReferenceBase64(
  ref: ResolvedReference,
): Promise<{ base64: string; mimeType: string }> {
  const response = await fetch(ref.url);
  if (!response.ok) {
    throw new ApiException('provider_error', `取参考图失败（${response.status}）`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 1) {
    binary += String.fromCharCode(buffer[i]);
  }
  return { base64: btoa(binary), mimeType: ref.mimeType };
}
