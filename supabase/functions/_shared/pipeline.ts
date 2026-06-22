/**
 * 生成流水线共享逻辑（第 05 篇第五节、第 06 篇第四节结果落库）。
 *
 * 三条推进 / 执行函数（消费队列、轮询、回调）到达成功时共享同一段「结果落库」：归一化
 * 资产候选 → 取回媒体转存 Storage → 建资产 → 占位节点原地转化为真实节点 → 任务置
 * succeeded。本模块还提供参考解析、模型上下文构建、参数校验与内容安全。
 *
 * @module functions/_shared/pipeline
 */

import {
  type AssetCandidate,
  type GenerationRow,
  type ImageGenerationParams,
  type ModelCapabilities,
  type ModelCatalogRow,
  type Provider,
  type UnifiedGenerationRequest,
  type VideoGenerationParams,
} from './types.ts';
import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';
import { type ModelContext, type ResolvedReference } from './adapters/base.ts';

/** 生成产物存储桶。 */
const GENERATIONS_BUCKET = 'generations';

/** 签名 URL 有效期（秒）：供适配器取参考图。 */
const REFERENCE_TTL = 3600;

/** 内容安全：明显违规关键词的最小阻断表（可按地区与合规扩展，第 05 篇第八节）。 */
const BLOCKLIST = ['child sexual', 'cp porn', '儿童色情'];

/** MIME → 文件扩展名。 */
function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  };
  return map[mime] ?? 'bin';
}

/**
 * 内容安全审核：拦截明显违规提示词。
 *
 * @param prompt - 提示词
 * @throws {ApiException} content_blocked
 */
export function moderatePrompt(prompt: string): void {
  const lower = prompt.toLowerCase();
  if (BLOCKLIST.some((word) => lower.includes(word))) {
    throw new ApiException('content_blocked', '提示词触发内容安全策略');
  }
}

/**
 * 按模型能力画像校验请求参数，对不支持者按策略降级（原地修改 params）或拒绝。
 *
 * @param capabilities - 能力画像
 * @param request - 生成请求（其 params 可能被降级修改）
 * @throws {ApiException} invalid_params / unsupported_param
 */
export function validateParams(
  capabilities: ModelCapabilities,
  request: UnifiedGenerationRequest,
): void {
  const params = request.params;
  if (params.references.length > 0 && !capabilities.supportsReferenceImages) {
    if (request.modality === 'video' && capabilities.supportsImageToVideo) {
      // 视频图生视频允许参考首帧
    } else {
      throw new ApiException('unsupported_param', '当前模型不支持参考图');
    }
  }

  if (params.modality === 'image') {
    const p = params as ImageGenerationParams;
    if (p.count < 1) throw new ApiException('invalid_params', '产出数量至少为 1');
    p.count = Math.min(p.count, capabilities.maxOutputs);
    if (p.quality && !capabilities.qualities.includes(p.quality)) {
      delete p.quality; // 降级：丢弃不支持的质量档
    }
    if (p.seed != null && !capabilities.supportsSeed) {
      delete p.seed;
    }
    if (
      p.aspectRatio &&
      !capabilities.aspectRatios.includes(p.aspectRatio) &&
      !(p.width && p.height)
    ) {
      throw new ApiException('unsupported_param', `模型不支持比例 ${p.aspectRatio}`);
    }
  }

  if (params.modality === 'video') {
    const p = params as VideoGenerationParams;
    if (capabilities.videoResolutions && !capabilities.videoResolutions.includes(p.resolution)) {
      throw new ApiException('unsupported_param', `模型不支持分辨率 ${p.resolution}`);
    }
    if (capabilities.videoDurationRange) {
      const { min, max } = capabilities.videoDurationRange;
      if (p.durationSec < min || p.durationSec > max) {
        throw new ApiException('invalid_params', `时长须在 ${min}~${max} 秒之间`);
      }
    }
  }
}

/**
 * 解析参考素材为带签名 URL 的引用，供适配器取回。
 *
 * @param admin - 管理员客户端
 * @param request - 生成请求（含 references）
 * @returns 已解析引用
 */
export async function resolveReferences(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
): Promise<ResolvedReference[]> {
  const references = request.params.references;
  if (references.length === 0) return [];

  const assetIds = references.map((r) => r.assetId);
  const { data: assets } = await admin
    .from('assets')
    .select('id, storage_bucket, storage_path, mime_type')
    .in('id', assetIds);
  const byId = new Map((assets ?? []).map((a) => [a.id, a]));

  const resolved: ResolvedReference[] = [];
  for (const ref of references) {
    const asset = byId.get(ref.assetId);
    if (!asset) continue;
    const { data } = await admin.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, REFERENCE_TTL);
    if (data?.signedUrl) {
      resolved.push({
        assetId: ref.assetId,
        role: ref.role,
        url: data.signedUrl,
        mimeType: asset.mime_type,
      });
    }
  }
  return resolved;
}

/**
 * 解析提供商侧的模型 / 端点 id：优先 default_params.providerModel，其次按 model_key
 * 配合环境变量给出合理默认。
 */
export function resolveProviderModel(
  modelKey: string,
  provider: Provider,
  defaultParams: Record<string, unknown>,
): string {
  const explicit = defaultParams.providerModel;
  if (typeof explicit === 'string' && explicit) return explicit;

  const env = (name: string, fallback: string) => Deno.env.get(name) ?? fallback;
  switch (modelKey) {
    case 'gpt-image-2':
      return env('OPENAI_IMAGE_MODEL', 'gpt-image-1');
    case 'nano-banana-pro':
      return env('GOOGLE_IMAGE_MODEL', 'gemini-2.5-flash-image-preview');
    case 'seedance-2.0':
      return env('ARK_SEEDANCE_MODEL', 'seedance-1-0-pro');
    case 'seedream-3.0':
      return env('ARK_SEEDREAM_MODEL', 'seedream-3-0-t2i');
    default:
      throw new ApiException('model_unavailable', `模型 ${modelKey}（${provider}）未配置端点`);
  }
}

/**
 * 构建适配器调用上下文。
 */
export async function buildModelContext(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
  model: ModelCatalogRow,
): Promise<ModelContext> {
  const references = await resolveReferences(admin, request);
  return {
    modelKey: model.key,
    capabilities: model.capabilities,
    providerModel: resolveProviderModel(model.key, model.provider, model.default_params),
    references,
  };
}

/** 把候选媒体取回为字节。 */
async function fetchCandidateBytes(candidate: AssetCandidate): Promise<Uint8Array> {
  if (candidate.fetch.type === 'bytes') return candidate.fetch.bytes;
  if (candidate.fetch.type === 'base64') {
    const binary = atob(candidate.fetch.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const response = await fetch(candidate.fetch.url, { headers: candidate.fetch.headers });
  if (!response.ok) {
    throw new ApiException('provider_error', `取回产出失败（${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** 把单个候选转存 Storage 并登记资产，返回资产 id 与尺寸。 */
async function landAsset(
  admin: SupabaseClient,
  candidate: AssetCandidate,
  generation: GenerationRow,
  ownerId: string,
): Promise<{ assetId: string; width: number | null; height: number | null }> {
  const assetId = crypto.randomUUID();
  const ext = extFromMime(candidate.mimeType);
  const path = `${ownerId}/${generation.project_id}/${assetId}.${ext}`;
  const bytes = await fetchCandidateBytes(candidate);

  const { error: uploadError } = await admin.storage
    .from(GENERATIONS_BUCKET)
    .upload(path, bytes, { contentType: candidate.mimeType, upsert: true });
  if (uploadError) {
    throw new ApiException('internal_error', `转存产出失败：${uploadError.message}`);
  }

  const { error: insertError } = await admin.from('assets').insert({
    id: assetId,
    owner_id: ownerId,
    project_id: generation.project_id,
    kind: candidate.kind,
    source: 'generation',
    generation_id: generation.id,
    storage_bucket: GENERATIONS_BUCKET,
    storage_path: path,
    mime_type: candidate.mimeType,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    duration_ms: candidate.durationMs ?? null,
    size_bytes: bytes.byteLength,
  });
  if (insertError) {
    throw new ApiException('internal_error', `登记资产失败：${insertError.message}`);
  }
  return { assetId, width: candidate.width ?? null, height: candidate.height ?? null };
}

/** 构建图片节点的类型私有内容（data 列）。 */
function imageContent(width: number | null, height: number | null): Record<string, unknown> {
  return {
    naturalWidth: width,
    naturalHeight: height,
    crop: null,
    filters: { brightness: 1, contrast: 1, saturation: 1, grayscale: 0, sepia: 0, blur: 0, hueRotate: 0 },
    opacity: 1,
    cornerRadius: 8,
    objectFit: 'cover',
    alt: '',
  };
}

/** 构建视频节点的类型私有内容（data 列）。 */
function videoContent(): Record<string, unknown> {
  return {
    posterAssetId: null,
    autoplay: false,
    muted: true,
    loop: false,
    trimStartMs: 0,
    trimEndMs: null,
    cornerRadius: 8,
  };
}

/**
 * 结果落库（完成阶段）。把成功的候选转存、建资产、占位转化为真实节点、任务置 succeeded。
 * 多产出时首张落占位、其余在占位附近新建节点。已终态任务直接跳过（状态机幂等）。
 *
 * @param admin - 管理员客户端
 * @param generation - 生成任务行
 * @param candidates - 资产候选
 */
export async function landResult(
  admin: SupabaseClient,
  generation: GenerationRow,
  candidates: AssetCandidate[],
): Promise<void> {
  // 幂等：已终态忽略迟到事件
  if (generation.status === 'succeeded' || generation.status === 'failed') return;
  if (candidates.length === 0) {
    await markFailed(admin, generation, '提供商未返回任何产出');
    return;
  }

  // 取项目归属与占位节点
  const { data: project } = await admin
    .from('projects')
    .select('owner_id')
    .eq('id', generation.project_id)
    .single();
  const ownerId = project?.owner_id as string | undefined;
  if (!ownerId) {
    await markFailed(admin, generation, '项目归属缺失');
    return;
  }

  const nodeType = candidates[0].kind; // image | video
  const landed: Array<{ assetId: string; width: number | null; height: number | null; kind: string }> = [];
  for (const candidate of candidates) {
    const result = await landAsset(admin, candidate, generation, ownerId);
    landed.push({ ...result, kind: candidate.kind });
  }

  const first = landed[0];

  // 占位节点 → 真实节点（原地改写：type / asset_id / data）
  let placeholderPos = { x: 0, y: 0 };
  let placeholderSize = { width: 320, height: 320 };
  if (generation.placeholder_node_id) {
    const { data: placeholder } = await admin
      .from('canvas_nodes')
      .select('position_x, position_y, width, height')
      .eq('id', generation.placeholder_node_id)
      .maybeSingle();
    if (placeholder) {
      placeholderPos = { x: placeholder.position_x, y: placeholder.position_y };
      placeholderSize = {
        width: placeholder.width ?? 320,
        height: placeholder.height ?? 320,
      };
    }
    await admin
      .from('canvas_nodes')
      .update({
        type: first.kind,
        asset_id: first.assetId,
        generation_id: generation.id,
        data: first.kind === 'video' ? videoContent() : imageContent(first.width, first.height),
      })
      .eq('id', generation.placeholder_node_id);
  }

  // 其余产出在占位附近新建节点（横向排布）
  for (let i = 1; i < landed.length; i += 1) {
    const item = landed[i];
    await admin.from('canvas_nodes').insert({
      project_id: generation.project_id,
      type: item.kind,
      position_x: placeholderPos.x + i * (placeholderSize.width + 24),
      position_y: placeholderPos.y,
      width: placeholderSize.width,
      height: placeholderSize.height,
      rotation: 0,
      z_index: 0,
      data: item.kind === 'video' ? videoContent() : imageContent(item.width, item.height),
      asset_id: item.assetId,
      generation_id: generation.id,
      created_by: ownerId,
    });
  }

  // 任务置成功
  await admin
    .from('generations')
    .update({
      status: 'succeeded',
      progress: 100,
      result_asset_id: first.assetId,
      error: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', generation.id);

  // 标记节点类型供静态分析；nodeType 仅作语义记录
  void nodeType;
}

/**
 * 标记任务失败（占位节点经 generations 进度回流转为可重试失败态）。
 *
 * @param admin - 管理员客户端
 * @param generation - 生成任务行
 * @param error - 失败原因
 */
export async function markFailed(
  admin: SupabaseClient,
  generation: GenerationRow,
  error: string,
): Promise<void> {
  if (generation.status === 'succeeded' || generation.status === 'failed') return;
  await admin
    .from('generations')
    .update({ status: 'failed', error, completed_at: new Date().toISOString() })
    .eq('id', generation.id);
}
