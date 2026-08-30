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
  type BaseImageEditParams,
  type GenerationRow,
  IMAGE_INPUT_MODES,
  type ImageGenerationParams,
  type ImageOperation,
  type InpaintImageParams,
  type LandGenerationResult,
  type ModelCapabilities,
  type ModelCatalogRow,
  type ModelDefaultParams,
  normalizeImageOperation,
  type OutpaintImageParams,
  type Provider,
  type ReferenceMaterial,
  TERMINAL_STATUSES,
  type UnifiedGenerationRequest,
  type UpscaleImageParams,
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
  adapterOperations: readonly ImageOperation[],
): void {
  const params = request.params;
  if (capabilities.requiresReferenceImages && params.references.length === 0) {
    throw new ApiException('invalid_params', '当前模型必须提供一张参考图');
  }
  if (params.references.length > 0 && !capabilities.supportsReferenceImages) {
    if (request.modality === 'video' && capabilities.supportsImageToVideo) {
      // 视频图生视频允许参考首帧
    } else {
      throw new ApiException('unsupported_param', '当前模型不支持参考图');
    }
  }

  if (params.modality === 'image') {
    const p = params as ImageGenerationParams;
    const isLegacyRequest = p.operation === undefined;
    const operation = normalizeImageOperation(p);
    const modelSupportsOperation = capabilities.imageOperations.includes(operation);
    const adapterSupportsOperation = adapterOperations.includes(operation);
    if (!modelSupportsOperation || !adapterSupportsOperation) {
      throw new ApiException('unsupported_param', '当前模型不支持该图片操作', {
        reason: 'unsupported_image_operation',
        operation,
      });
    }

    if (
      isLegacyRequest &&
      (p.references.some((reference) => reference.role === 'mask') ||
        'outputCanvas' in p ||
        'upscaleFactor' in p ||
        'background' in p)
    ) {
      throw new ApiException('invalid_params', '旧版图片请求不能携带精准编辑专属参数', {
        reason: 'invalid_edit_input_count',
        operation,
      });
    }

    // 规范化发生在幂等哈希之前，使旧请求与等价新请求具有相同语义。
    (p as ImageGenerationParams & { operation: ImageOperation }).operation = operation;
    if (isLegacyRequest && operation === 'semantic_edit') {
      (p as BaseImageEditParams).inputMode = 'original';
    }
    if (p.count < 1) throw new ApiException('invalid_params', '产出数量至少为 1');
    if (operation === 'remove_background' || operation === 'upscale') {
      if (p.count !== 1) {
        throw new ApiException('invalid_params', '去背景与高清放大只能产出一个结果', {
          reason: 'invalid_edit_input_count',
          operation,
        });
      }
    } else if (operation === 'generate') {
      // 保持旧生成入口的兼容行为；精准编辑对候选数量使用严格校验。
      p.count = Math.min(p.count, capabilities.maxOutputs);
    } else if (p.count > Math.min(4, capabilities.maxOutputs)) {
      throw new ApiException('invalid_params', '编辑候选数量超出模型上限', {
        reason: 'invalid_edit_input_count',
        operation,
      });
    }

    const contentReferences = p.references.filter((reference) => reference.role === 'content');
    const maskReferences = p.references.filter((reference) => reference.role === 'mask');
    const nonMaskReferences = p.references.length - maskReferences.length;
    if (
      capabilities.maxInputImages != null &&
      nonMaskReferences > capabilities.maxInputImages
    ) {
      throw new ApiException('unsupported_param', '输入图片数量超出模型上限', {
        reason: 'invalid_edit_input_count',
        operation,
        maxInputImages: capabilities.maxInputImages,
      });
    }

    if (operation !== 'generate' && contentReferences.length !== 1) {
      throw new ApiException('invalid_params', '图片编辑必须且只能提供一张内容源图', {
        reason: 'invalid_edit_input_count',
        operation,
      });
    }
    if (operation !== 'generate') {
      const editParams = p as BaseImageEditParams;
      if (!IMAGE_INPUT_MODES.includes(editParams.inputMode)) {
        throw new ApiException('invalid_params', '图片编辑输入模式无效', {
          reason: 'invalid_edit_input_count',
          operation,
        });
      }
    }
    if (operation === 'inpaint') {
      const inpaintParams = p as InpaintImageParams;
      if (maskReferences.length !== 1) {
        throw new ApiException('invalid_params', '局部重绘必须且只能提供一张蒙版', {
          reason: 'invalid_edit_input_count',
          operation,
        });
      }
      if (
        !Number.isInteger(inpaintParams.maskFeatherPx) ||
        inpaintParams.maskFeatherPx < 0 ||
        inpaintParams.maskFeatherPx > 128
      ) {
        throw new ApiException('invalid_params', '蒙版羽化必须是 0–128 的整数', {
          reason: 'invalid_edit_input_count',
          operation,
        });
      }
    } else if (maskReferences.length > 0) {
      throw new ApiException('invalid_params', '当前图片操作不接受蒙版', {
        reason: 'invalid_edit_input_count',
        operation,
      });
    }

    const editParams = operation === 'generate' ? null : (p as BaseImageEditParams);
    if (editParams?.inputFidelity) {
      if (!capabilities.inputFidelityOptions?.includes(editParams.inputFidelity)) {
        throw new ApiException('unsupported_param', '模型不支持请求的输入保真度', {
          reason: 'unsupported_image_operation',
          operation,
        });
      }
    }
    if (editParams?.background === 'transparent' && !capabilities.supportsTransparentOutput) {
      throw new ApiException('unsupported_param', '模型不支持透明背景输出', {
        reason: 'transparent_output_unsupported',
        operation,
      });
    }
    if (operation === 'outpaint') {
      const canvas = (p as OutpaintImageParams).outputCanvas;
      const values = [
        canvas.width,
        canvas.height,
        canvas.sourceX,
        canvas.sourceY,
        canvas.sourceWidth,
        canvas.sourceHeight,
      ];
      const allIntegers = values.every(Number.isInteger);
      const sourceFits = canvas.sourceX >= 0 &&
        canvas.sourceY >= 0 &&
        canvas.sourceWidth > 0 &&
        canvas.sourceHeight > 0 &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        canvas.sourceX + canvas.sourceWidth <= canvas.width &&
        canvas.sourceY + canvas.sourceHeight <= canvas.height;
      if (!allIntegers || !sourceFits) {
        throw new ApiException('invalid_params', '扩图画布不能完整容纳源图', {
          reason: 'output_canvas_invalid',
          operation,
        });
      }
    }
    if (operation === 'upscale') {
      const upscaleParams = p as UpscaleImageParams;
      if (!capabilities.upscaleFactors?.includes(upscaleParams.upscaleFactor)) {
        throw new ApiException('unsupported_param', '模型不支持请求的放大倍率', {
          reason: 'upscale_factor_unsupported',
          operation,
        });
      }
    }
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
    if (
      capabilities.videoResolutions?.length &&
      !capabilities.videoResolutions.includes(p.resolution)
    ) {
      // 兼容已打开页面或历史节点仍携带旧模型参数：降级到当前模型首个有效分辨率。
      p.resolution = capabilities.videoResolutions[0];
    }
    if (capabilities.videoDurationRange) {
      const { min, max } = capabilities.videoDurationRange;
      p.durationSec = Math.min(max, Math.max(min, p.durationSec));
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
export function resolveReferences(
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
export function resolveKeyframes(
  admin: SupabaseClient,
  request: UnifiedGenerationRequest,
): Promise<ResolvedReference[]> {
  if (request.params.modality !== 'video') return Promise.resolve([]);
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
    case 'seededit-3.0':
      return env('ARK_SEEDEDIT_MODEL', 'doubao-seededit-3-0-i2i-250628');
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

/** 一次结果转存尝试的持久化上下文。 */
interface OutputAttempt {
  id: string;
  prefix: string;
  paths: string[];
}

/** 创建任务专属的 Storage 暂存尝试账本。 */
async function beginOutputAttempt(
  admin: SupabaseClient,
  generation: GenerationRow,
  ownerId: string,
): Promise<OutputAttempt> {
  const id = crypto.randomUUID();
  const prefix = `staging/${ownerId}/${generation.id}/${id}/`;
  const { error } = await admin.from('generation_output_attempts').insert({
    id,
    generation_id: generation.id,
    owner_id: ownerId,
    staging_prefix: prefix,
    storage_bucket: GENERATIONS_BUCKET,
    object_paths: [],
    status: 'uploading',
  });
  if (error) {
    throw new ApiException('internal_error', `创建产出暂存尝试失败：${error.message}`);
  }
  return { id, prefix, paths: [] };
}

/** 在写对象前持久记录目标路径，确保进程中断后补偿任务仍能精确清理。 */
async function recordAttemptPaths(
  admin: SupabaseClient,
  attempt: OutputAttempt,
  paths: string[],
  status: 'uploading' | 'staged' = 'uploading',
): Promise<void> {
  for (const path of paths) {
    if (!attempt.paths.includes(path)) attempt.paths.push(path);
  }
  const { error } = await admin
    .from('generation_output_attempts')
    .update({ object_paths: attempt.paths, status })
    .eq('id', attempt.id);
  if (error) {
    throw new ApiException('internal_error', `记录产出暂存路径失败：${error.message}`);
  }
}

/** 更新暂存尝试状态；状态账本失败不掩盖原始流水线错误。 */
async function setAttemptStatus(
  admin: SupabaseClient,
  attempt: OutputAttempt,
  status: 'staged' | 'discarded' | 'rpc_failed' | 'cleaned',
  error?: string,
): Promise<void> {
  const { error: updateError } = await admin
    .from('generation_output_attempts')
    .update({ status, object_paths: attempt.paths, error: error ?? null })
    .eq('id', attempt.id)
    // RPC 可能已提交但响应在网络中丢失；绝不能把 committed 降回可清理状态。
    .neq('status', 'committed');
  if (updateError) {
    console.error(`更新生成暂存尝试 ${attempt.id} 状态失败：${updateError.message}`);
  }
}

/** 精确删除当前尝试记录的对象，不扫描任何正式业务前缀。 */
async function cleanupAttemptObjects(
  admin: SupabaseClient,
  attempt: OutputAttempt,
): Promise<void> {
  if (attempt.paths.length > 0) {
    const { error } = await admin.storage.from(GENERATIONS_BUCKET).remove(attempt.paths);
    if (error) {
      await setAttemptStatus(admin, attempt, 'discarded', error.message);
      return;
    }
  }
  await setAttemptStatus(admin, attempt, 'cleaned');
}

/** 把单个候选转存 Storage（含缩略图），返回资产元数据（尚未入库）。 */
async function uploadAsset(
  admin: SupabaseClient,
  candidate: AssetCandidate,
  attempt: OutputAttempt,
): Promise<AssetMeta> {
  const assetId = crypto.randomUUID();
  const { bytes, contentType } = await fetchCandidate(candidate);
  // 实际 Content-Type 优先于候选自报 MIME（修正回调端硬编码 image/png 等）
  const mimeType = contentType ?? candidate.mimeType;
  const ext = extFromMime(mimeType);
  const path = `${attempt.prefix}${assetId}.${ext}`;

  await recordAttemptPaths(admin, attempt, [path]);

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
      const tPath = `${attempt.prefix}${assetId}_thumb.png`;
      await recordAttemptPaths(admin, attempt, [tPath]);
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

/** 由生成任务参数回填媒体节点默认配置。 */
function generationSettings(generation: GenerationRow): Record<string, unknown> {
  const params = generation.params as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {
    modelKey: generation.model_key,
    count: typeof params.count === 'number' ? params.count : 1,
  };
  for (
    const key of [
      'aspectRatio',
      'width',
      'height',
      'sizePreset',
      'quality',
      'durationSec',
      'resolution',
      'fps',
      'motionStrength',
    ]
  ) {
    if (params[key] != null) out[key] = params[key];
  }
  return out;
}

/** 构造媒体节点 data，区分主媒体与候选媒体。 */
function mediaNodeData(
  meta: AssetMeta,
  generation: GenerationRow,
  options: {
    role: 'primary' | 'candidate';
    candidateOf: string | null;
    candidateIndex: number | null;
    mediaDescription: string;
    groupId?: string;
  },
): Record<string, unknown> {
  return {
    ...nodeData(meta),
    mediaDescription: options.mediaDescription,
    generationSettings: generationSettings(generation),
    mediaRole: options.role,
    candidateOf: options.candidateOf,
    candidateIndex: options.candidateIndex,
    sourceGenerationId: generation.id,
    candidatesCollapsed: false,
    ...(options.groupId ? { groupId: options.groupId } : {}),
  };
}

/** 候选默认排在主媒体右侧，并按树状分叉展开。 */
const MEDIA_PANEL_GAP = 24;
const MEDIA_PANEL_COLLAPSED_HEIGHT = 56;
const CANDIDATE_HORIZONTAL_GAP_MIN = 280;
const CANDIDATE_HORIZONTAL_GAP_RATIO = 1;
const CANDIDATE_BRANCH_X_STEP_MIN = 88;
const CANDIDATE_BRANCH_X_STEP_RATIO = 0.28;
const CANDIDATE_COLUMN_GAP_MIN = 144;
const CANDIDATE_COLUMN_GAP_RATIO = 0.45;
const CANDIDATE_BRANCH_GAP_MIN = 96;
const CANDIDATE_BRANCH_GAP_RATIO = 0.35;
const CANDIDATE_CENTER_CORRIDOR_ROWS = 0.75;
const CANDIDATE_SLOTS_PER_COLUMN = 4;

function candidatePosition(
  targetPos: { x: number; y: number },
  size: { width: number; height: number },
  index: number,
): { x: number; y: number } {
  const horizontalGap = Math.max(
    CANDIDATE_HORIZONTAL_GAP_MIN,
    Math.round(size.width * CANDIDATE_HORIZONTAL_GAP_RATIO),
  );
  const verticalStep = size.height +
    MEDIA_PANEL_GAP +
    MEDIA_PANEL_COLLAPSED_HEIGHT +
    Math.max(CANDIDATE_BRANCH_GAP_MIN, Math.round(size.height * CANDIDATE_BRANCH_GAP_RATIO));
  const rowOffset = candidateBranchRowOffset(index);
  const column = candidateBranchColumn(index);
  const branchXStep = Math.max(
    CANDIDATE_BRANCH_X_STEP_MIN,
    Math.round(size.width * CANDIDATE_BRANCH_X_STEP_RATIO),
  );
  const columnGap = Math.max(
    CANDIDATE_COLUMN_GAP_MIN,
    Math.round(size.width * CANDIDATE_COLUMN_GAP_RATIO),
  );
  return {
    x: targetPos.x +
      size.width +
      horizontalGap +
      column * (size.width + columnGap) +
      Math.abs(rowOffset) * branchXStep,
    y: targetPos.y + rowOffset * verticalStep,
  };
}

/** 候选按树状分叉排布，并始终避开主路线所在的中心走廊。 */
function candidateBranchRowOffset(index: number): number {
  const safeIndex = Math.max(0, Math.floor(index));
  const columnIndex = safeIndex % CANDIDATE_SLOTS_PER_COLUMN;
  const pairIndex = Math.floor(columnIndex / 2);
  const distance = pairIndex + CANDIDATE_CENTER_CORRIDOR_ROWS;
  return columnIndex % 2 === 0 ? -distance : distance;
}

/** 每列放固定数量候选，放满后向右开新列，避免无限向上/下延伸。 */
function candidateBranchColumn(index: number): number {
  const safeIndex = Math.max(0, Math.floor(index));
  return Math.floor(safeIndex / CANDIDATE_SLOTS_PER_COLUMN);
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
  if (TERMINAL_STATUSES.has(generation.status)) return;
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

  // 1) 每个 webhook / poll / queue 完成者使用独立暂存前缀，失败补偿互不影响。
  const attempt = await beginOutputAttempt(admin, generation, ownerId);
  const uploaded: AssetMeta[] = [];
  try {
    for (const candidate of candidates) {
      uploaded.push(await uploadAsset(admin, candidate, attempt));
    }
    await recordAttemptPaths(admin, attempt, [], 'staged');
  } catch (error) {
    await cleanupAttemptObjects(admin, attempt);
    throw error;
  }

  // 2) 产出端审核（图像）：命中即丢弃该资产；视频交由提供商策略
  const imageMetas = uploaded.filter((m) => m.kind === 'image');
  let blockedReason: string | null = null;
  const survivors: AssetMeta[] = [];
  try {
    if (imageMetas.length > 0) {
      const signed = await Promise.all(
        imageMetas.map((m) =>
          admin.storage.from(GENERATIONS_BUCKET).createSignedUrl(m.storagePath, REFERENCE_TTL)
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
  } catch (error) {
    await cleanupAttemptObjects(admin, attempt);
    throw error;
  }

  if (survivors.length === 0) {
    await cleanupAttemptObjects(admin, attempt);
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
  let targetPos = placeholderPos;
  let targetSize = placeholderSize;
  let targetMediaDescription = '';
  const resultMode = generation.result_mode ?? 'new_primary';
  const targetNodeId = resultMode === 'candidate_for_target'
    ? generation.target_node_id
    : generation.placeholder_node_id;
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
  if (targetNodeId) {
    const { data: target } = await admin
      .from('canvas_nodes')
      .select('position_x, position_y, width, height, data')
      .eq('id', targetNodeId)
      .maybeSingle();
    if (target) {
      targetPos = { x: target.position_x, y: target.position_y };
      targetSize = {
        width: target.width ?? placeholderSize.width,
        height: target.height ?? placeholderSize.height,
      };
      const tdata = target.data as Record<string, unknown> | null;
      if (tdata && typeof tdata.mediaDescription === 'string') {
        targetMediaDescription = tdata.mediaDescription;
      }
    }
  }

  let existingCandidateCount = 0;
  if (targetNodeId) {
    const { count } = await admin
      .from('canvas_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', generation.project_id)
      .eq('data->>candidateOf', targetNodeId);
    existingCandidateCount = count ?? 0;
  }

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
      data: mediaNodeData(survivors[0], generation, {
        role: resultMode === 'candidate_for_target' ? 'candidate' : 'primary',
        candidateOf: resultMode === 'candidate_for_target' ? targetNodeId : null,
        candidateIndex: resultMode === 'candidate_for_target' ? existingCandidateCount : null,
        mediaDescription: targetMediaDescription,
        groupId: placeholderGroupId,
      }),
    }
    : null;
  const extraNodes = survivors.slice(extraStart).map((m, idx) => {
    const i = idx + (hasPlaceholder ? 1 : 0);
    const candidateOf = resultMode === 'candidate_for_target'
      ? targetNodeId
      : generation.placeholder_node_id;
    const candidateIdx = resultMode === 'candidate_for_target' ? existingCandidateCount + i : i - 1;
    const pos = candidateOf
      ? candidatePosition(targetPos, targetSize, candidateIdx)
      : { x: placeholderPos.x + i * (placeholderSize.width + 24), y: placeholderPos.y };
    return {
      id: crypto.randomUUID(),
      type: m.kind,
      positionX: pos.x,
      positionY: pos.y,
      width: targetSize.width,
      height: targetSize.height,
      assetId: m.id,
      data: mediaNodeData(m, generation, {
        role: 'candidate',
        candidateOf,
        candidateIndex: candidateIdx,
        mediaDescription: targetMediaDescription,
      }),
    };
  });

  // 5) 单一事务原子落库
  // 被审核丢弃的对象已经删除；账本只保留本次将提交的正式引用路径。
  attempt.paths = survivors.flatMap((meta) =>
    meta.thumbnailPath ? [meta.storagePath, meta.thumbnailPath] : [meta.storagePath]
  );
  await recordAttemptPaths(admin, attempt, [], 'staged');

  const { data, error } = await admin.rpc('land_generation_result_once', {
    p_generation_id: generation.id,
    p_owner_id: ownerId,
    p_project_id: generation.project_id,
    p_placeholder_node_id: generation.placeholder_node_id,
    p_attempt_id: attempt.id,
    p_assets: survivors.map(toAssetJson),
    p_first_node: firstNode,
    p_extra_nodes: extraNodes,
    p_result_asset_id: survivors[0].id,
    p_provider_output_summary: {
      attemptId: attempt.id,
      outputCount: survivors.length,
      outputs: survivors.map((item) => ({
        kind: item.kind,
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        sizeBytes: item.sizeBytes,
      })),
    },
  });
  if (error) {
    // 网络 / RPC 未知结果不能立即删除：保留短期 staging，由账本补偿任务安全清理。
    await setAttemptStatus(admin, attempt, 'rpc_failed', error.message);
    throw new ApiException('internal_error', `结果落库失败：${error.message}`);
  }
  const result = data as LandGenerationResult | null;
  if (!result) {
    await setAttemptStatus(admin, attempt, 'rpc_failed', 'RPC 未返回结果');
    throw new ApiException('internal_error', '结果落库 RPC 未返回结果');
  }
  if (!result.landed) {
    // 并发输家只删除自己的任务级暂存前缀，不影响获胜事务登记的资产。
    await cleanupAttemptObjects(admin, attempt);
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
  if (TERMINAL_STATUSES.has(generation.status)) return;
  const { error: rpcError } = await admin.rpc('fail_generation_once', {
    p_generation_id: generation.id,
    p_error: error,
    p_moderation_reason: moderationReason ?? null,
  });
  if (rpcError) {
    throw new ApiException('internal_error', `提交生成失败终态失败：${rpcError.message}`);
  }
}
