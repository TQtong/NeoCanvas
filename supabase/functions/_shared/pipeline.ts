/**
 * 生成流水线共享逻辑（第 05 篇第五节、第 06 篇第四节结果落库）。
 *
 * 三条推进 / 执行函数（消费队列、轮询、回调）到达成功时共享同一段「结果落库」：归一化
 * 资产候选 → 取回媒体转存 Storage（含缩略图）→ 产出端内容审核 → 经单一事务把资产入库、
 * 占位节点原地转化为真实节点、任务置 succeeded。本模块还提供参考解析（含参考图审核）、
 * 模型上下文构建与参数校验。
 *
 * @module functions/_shared/pipeline
 */

import {
  type AssetCandidate,
  type GenerationRow,
  type ImageGenerationParams,
  type ModelCapabilities,
  type ModelCatalogRow,
  type ModelDefaultParams,
  type Provider,
  type ReferenceMaterial,
  type UnifiedGenerationRequest,
  type VideoGenerationParams,
} from './types.ts';
import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';
import { type ModelContext, type ResolvedReference } from './adapters/base.ts';
import { resolveProviderCredential } from './credentials.ts';
import { moderateOutputImages, moderateReferenceImages } from './moderation.ts';
import { makeImageThumbnail, THUMBNAIL_MIME } from './image.ts';

/** 生成产物存储桶。 */
const GENERATIONS_BUCKET = 'generations';

/** 签名 URL 有效期（秒）：供适配器取参考图 / 产出审核。 */
const REFERENCE_TTL = 3600;

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
    // 关键帧序列（逐段首尾帧）：需模型声明支持关键帧序列、至少 2 帧、且与单首帧参考互斥
    const keyframes = p.keyframes ?? [];
    if (keyframes.length > 0) {
      if (!capabilities.supportsKeyframeSequence) {
        throw new ApiException('unsupported_param', '当前模型不支持关键帧序列（逐段首尾帧）视频');
      }
      if (keyframes.length < 2) {
        throw new ApiException('invalid_params', '关键帧序列至少需要 2 帧');
      }
      if (p.references.length > 0) {
        throw new ApiException('unsupported_param', '关键帧序列与单首帧参考不可同时使用');
      }
    }
  }
}

/**
 * 把一组参考素材解析为带签名 URL 的引用（保序、跳过缺失资产），并对其中图像类做输入端审核。
 * 是 {@link resolveReferences} 与 {@link resolveKeyframes} 的共用底座。
 *
 * @param admin - 管理员客户端
 * @param materials - 参考素材（无序 references 或有序 keyframes）
 * @returns 已解析引用（与输入同序，缺失资产被跳过）
 * @throws {ApiException} content_blocked 当图像参考触发审核
 */
async function resolveMaterials(
  admin: SupabaseClient,
  materials: ReferenceMaterial[],
): Promise<ResolvedReference[]> {
  if (materials.length === 0) return [];

  const assetIds = materials.map((r) => r.assetId);
  const { data: assets } = await admin
    .from('assets')
    .select('id, storage_bucket, storage_path, mime_type')
    .in('id', assetIds);
  const byId = new Map((assets ?? []).map((a) => [a.id, a]));

  const resolved: ResolvedReference[] = [];
  for (const ref of materials) {
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

  // 输入端审核：参考图（仅图像类参考）
  const imageRefs = resolved.filter((r) => r.mimeType.startsWith('image/')).map((r) => r.url);
  await moderateReferenceImages(imageRefs);

  return resolved;
}

/**
 * 解析参考素材（无序首帧 / 风格 / 内容参考）为带签名 URL 的引用，供适配器取回；并审核参考图。
 *
 * @param admin - 管理员客户端
 * @param request - 生成请求（含 params.references）
 * @returns 已解析引用
 * @throws {ApiException} content_blocked 当参考图触发审核
 */
export async function resolveReferences(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
): Promise<ResolvedReference[]> {
  return resolveMaterials(admin, request.params.references);
}

/**
 * 解析视频「逐段首尾帧」的有序关键帧（params.keyframes）为带签名 URL 的引用，保序并审核关键帧图像。
 * 非视频请求或无关键帧时返回空数组。
 *
 * @param admin - 管理员客户端
 * @param request - 生成请求
 * @returns 有序的已解析关键帧引用
 * @throws {ApiException} content_blocked 当关键帧触发审核
 */
export async function resolveKeyframes(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
): Promise<ResolvedReference[]> {
  if (request.params.modality !== 'video') return [];
  return resolveMaterials(admin, request.params.keyframes ?? []);
}

/**
 * 解析提供商侧的模型 / 端点 id：优先 default_params.providerModel，其次按 model_key
 * 配合环境变量给出合理默认。
 */
export function resolveProviderModel(
  modelKey: string,
  provider: Provider,
  defaultParams: ModelDefaultParams,
): string {
  if (defaultParams.providerModel) return defaultParams.providerModel;

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
  const keyframes = await resolveKeyframes(admin, request);
  // 密钥解析单点：按请求归属用户解析该 provider 的 Key / 端点（用户凭证 → 环境变量回退）
  const credentials = await resolveProviderCredential(admin, model.provider, request.projectId);
  return {
    modelKey: model.key,
    capabilities: model.capabilities,
    providerModel: resolveProviderModel(model.key, model.provider, model.default_params),
    references,
    keyframes,
    credentials,
  };
}

/** 取回候选媒体字节，并尽量带回真实 Content-Type（用于修正硬编码 MIME）。 */
async function fetchCandidate(
  candidate: AssetCandidate,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  if (candidate.fetch.type === 'bytes') return { bytes: candidate.fetch.bytes, contentType: null };
  if (candidate.fetch.type === 'base64') {
    const binary = atob(candidate.fetch.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType: null };
  }
  const response = await fetch(candidate.fetch.url, { headers: candidate.fetch.headers });
  if (!response.ok) {
    throw new ApiException('provider_error', `取回产出失败（${response.status}）`);
  }
  const raw = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const contentType = /^(image|video)\//.test(raw) ? raw : null;
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
}

/** 落库前的资产元数据（已转存 Storage，待经事务 RPC 写入数据库）。 */
interface AssetMeta {
  id: string;
  kind: AssetCandidate['kind'];
  mimeType: string;
  storageBucket: string;
  storagePath: string;
  thumbnailPath: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sizeBytes: number;
}

/** 把单个候选转存 Storage（含缩略图），返回资产元数据（尚未入库）。 */
async function uploadAsset(
  admin: SupabaseClient,
  candidate: AssetCandidate,
  generation: GenerationRow,
  ownerId: string,
): Promise<AssetMeta> {
  const assetId = crypto.randomUUID();
  const { bytes, contentType } = await fetchCandidate(candidate);
  // 实际 Content-Type 优先于候选自报 MIME（修正回调端硬编码 image/png 等）
  const mimeType = contentType ?? candidate.mimeType;
  const ext = extFromMime(mimeType);
  const path = `${ownerId}/${generation.project_id}/${assetId}.${ext}`;

  const { error: uploadError } = await admin.storage
    .from(GENERATIONS_BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: true });
  if (uploadError) {
    throw new ApiException('internal_error', `转存产出失败：${uploadError.message}`);
  }

  // 缩略图（仅图像；视频暂不在边缘抽帧）
  let thumbnailPath: string | null = null;
  if (candidate.kind === 'image') {
    const thumb = await makeImageThumbnail(bytes);
    if (thumb) {
      const tPath = `${ownerId}/${generation.project_id}/${assetId}_thumb.png`;
      const { error: tErr } = await admin.storage
        .from(GENERATIONS_BUCKET)
        .upload(tPath, thumb.bytes, { contentType: THUMBNAIL_MIME, upsert: true });
      if (!tErr) thumbnailPath = tPath;
    }
  }

  return {
    id: assetId,
    kind: candidate.kind,
    mimeType,
    storageBucket: GENERATIONS_BUCKET,
    storagePath: path,
    thumbnailPath,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    durationMs: candidate.durationMs ?? null,
    sizeBytes: bytes.byteLength,
  };
}

/** 删除已转存但被产出审核拦截的资产对象（含缩略图）。 */
async function discardUploaded(admin: SupabaseClient, meta: AssetMeta): Promise<void> {
  const paths = [meta.storagePath];
  if (meta.thumbnailPath) paths.push(meta.thumbnailPath);
  await admin.storage.from(GENERATIONS_BUCKET).remove(paths);
}

/** 构建图片节点的类型私有内容（data 列）。 */
function imageContent(width: number | null, height: number | null): Record<string, unknown> {
  return {
    naturalWidth: width,
    naturalHeight: height,
    crop: null,
    filters: {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      grayscale: 0,
      sepia: 0,
      blur: 0,
      hueRotate: 0,
    },
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

/** 由资产元数据构造节点 data。 */
function nodeData(meta: AssetMeta): Record<string, unknown> {
  return meta.kind === 'video' ? videoContent() : imageContent(meta.width, meta.height);
}

/**
 * 结果落库（完成阶段）。把成功的候选转存 + 缩略图、产出端审核、再经单一事务原子写库：
 * 资产入库、占位节点原地转真实节点、其余产出新建节点、任务置 succeeded。
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

  // 取项目归属
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

  // 1) 转存全部候选（含缩略图）
  const uploaded: AssetMeta[] = [];
  for (const candidate of candidates) {
    uploaded.push(await uploadAsset(admin, candidate, generation, ownerId));
  }

  // 2) 产出端审核（图像）：命中即丢弃该资产；视频交由提供商策略
  const imageMetas = uploaded.filter((m) => m.kind === 'image');
  let blockedReason: string | null = null;
  const survivors: AssetMeta[] = [];
  if (imageMetas.length > 0) {
    const signed = await Promise.all(
      imageMetas.map((m) =>
        admin.storage.from(GENERATIONS_BUCKET).createSignedUrl(m.storagePath, REFERENCE_TTL),
      ),
    );
    for (let i = 0; i < imageMetas.length; i += 1) {
      const url = signed[i].data?.signedUrl;
      const reason = url ? await moderateOutputImages([url]) : null;
      if (reason) {
        blockedReason = reason;
        await discardUploaded(admin, imageMetas[i]);
      } else {
        survivors.push(imageMetas[i]);
      }
    }
  }
  // 非图像产出（视频）直接保留
  for (const m of uploaded) {
    if (m.kind !== 'image') survivors.push(m);
  }

  if (survivors.length === 0) {
    await markFailed(
      admin,
      generation,
      `产出触发内容安全审核：${blockedReason ?? '违规'}`,
      blockedReason ?? '产出违规',
    );
    return;
  }

  // 3) 读取占位节点位置 / 尺寸 / 组归属，规划余产出排布
  let placeholderPos = { x: 0, y: 0 };
  let placeholderSize = { width: 320, height: 320 };
  let placeholderGroupId: string | undefined;
  const hasPlaceholder = Boolean(generation.placeholder_node_id);
  if (hasPlaceholder) {
    const { data: placeholder } = await admin
      .from('canvas_nodes')
      .select('position_x, position_y, width, height, data')
      .eq('id', generation.placeholder_node_id)
      .maybeSingle();
    if (placeholder) {
      placeholderPos = { x: placeholder.position_x, y: placeholder.position_y };
      placeholderSize = { width: placeholder.width ?? 320, height: placeholder.height ?? 320 };
      // 保留占位节点的 groupId，使原地重生成（占位由真实节点改写而来）落库后仍属同一逻辑组
      const pdata = placeholder.data as Record<string, unknown> | null;
      if (pdata && typeof pdata.groupId === 'string') placeholderGroupId = pdata.groupId;
    }
  }

  // 4) 构建首节点（占位原地改写）与余节点载荷
  const toAssetJson = (m: AssetMeta) => ({
    id: m.id,
    kind: m.kind,
    mimeType: m.mimeType,
    storageBucket: m.storageBucket,
    storagePath: m.storagePath,
    thumbnailPath: m.thumbnailPath,
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    sizeBytes: m.sizeBytes,
  });

  const extraStart = hasPlaceholder ? 1 : 0;
  const firstNode = hasPlaceholder
    ? {
        type: survivors[0].kind,
        assetId: survivors[0].id,
        // 合并占位的 groupId（若有），使原地重生成结果不脱组
        data: placeholderGroupId
          ? { ...nodeData(survivors[0]), groupId: placeholderGroupId }
          : nodeData(survivors[0]),
      }
    : null;
  const extraNodes = survivors.slice(extraStart).map((m, idx) => {
    const i = idx + (hasPlaceholder ? 1 : 0);
    return {
      type: m.kind,
      positionX: placeholderPos.x + i * (placeholderSize.width + 24),
      positionY: placeholderPos.y,
      width: placeholderSize.width,
      height: placeholderSize.height,
      assetId: m.id,
      data: nodeData(m),
    };
  });

  // 5) 单一事务原子落库
  const { error } = await admin.rpc('land_generation_result', {
    p_generation_id: generation.id,
    p_owner_id: ownerId,
    p_project_id: generation.project_id,
    p_placeholder_node_id: generation.placeholder_node_id,
    p_assets: survivors.map(toAssetJson),
    p_first_node: firstNode,
    p_extra_nodes: extraNodes,
    p_result_asset_id: survivors[0].id,
  });
  if (error) {
    throw new ApiException('internal_error', `结果落库失败：${error.message}`);
  }
}

/**
 * 标记任务失败（占位节点经 generations 进度回流转为可重试失败态）。
 *
 * @param admin - 管理员客户端
 * @param generation - 生成任务行
 * @param error - 失败原因
 * @param moderationReason - 若因内容安全失败，记录拦截原因并置 moderation_status=blocked
 */
export async function markFailed(
  admin: SupabaseClient,
  generation: GenerationRow,
  error: string,
  moderationReason?: string,
): Promise<void> {
  if (generation.status === 'succeeded' || generation.status === 'failed') return;
  const patch: Record<string, unknown> = {
    status: 'failed',
    error,
    completed_at: new Date().toISOString(),
  };
  if (moderationReason) {
    patch.moderation_status = 'blocked';
    patch.moderation_reason = moderationReason;
  }
  await admin.from('generations').update(patch).eq('id', generation.id);
}
