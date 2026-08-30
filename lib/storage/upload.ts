'use client';

/**
 * 媒体上传封装（画布上传图片与对话附件共用，第 04 篇第六节）。
 *
 * 客户端直传到 `uploads` 私有桶（路径以用户 id 为顶层前缀），随后在 `assets` 登记
 * 一行（来源 upload），并返回带签名 URL 的资产视图。图片 / 视频的像素尺寸与时长在
 * 上传前于浏览器侧探测，写入资产元信息。
 *
 * @module lib/storage/upload
 */

import type { AssetKind, AssetView } from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';
import { uuid } from '@/lib/utils/id';
import { resolveAssetView } from './signed-url';

/** 上传桶名。 */
export const UPLOADS_BUCKET = 'uploads';

/** 头像桶名（公开读、按用户目录限写）。 */
export const AVATARS_BUCKET = 'avatars';

/** 上传参数。 */
export interface UploadAssetParams {
  /** 待上传文件。 */
  file: File;
  /** 上传者用户标识（路径首段）。 */
  userId: string;
  /** 关联项目（可空，路径次段；无项目时归入 loose）。 */
  projectId?: string | null;
  /** 是否为蒙版、合并当前外观或降采样输入等辅助资产。 */
  isAuxiliary?: boolean;
  /** 进度回调（0..1，依赖浏览器 XHR 时可用；此处以二值上报）。 */
  onProgress?: (ratio: number) => void;
}

/** 探测到的媒体元信息。 */
interface MediaMeta {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/**
 * 由 MIME 推断资产种类。
 */
function kindFromMime(mime: string): AssetKind {
  return mime.startsWith('video/') ? 'video' : 'image';
}

/**
 * 由文件名取扩展名（小写，无点）。
 */
function extFromFile(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : undefined;
  if (fromName) return fromName.toLowerCase();
  const fromMime = file.type.split('/')[1];
  return (fromMime ?? 'bin').toLowerCase();
}

/**
 * 在浏览器侧探测图片像素尺寸。
 */
async function probeImage(file: File): Promise<MediaMeta> {
  try {
    const bitmap = await createImageBitmap(file);
    const meta = { width: bitmap.width, height: bitmap.height, durationMs: null };
    bitmap.close();
    return meta;
  } catch {
    return { width: null, height: null, durationMs: null };
  }
}

/**
 * 在浏览器侧探测视频尺寸与时长。
 */
function probeVideo(file: File): Promise<MediaMeta> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const meta: MediaMeta = {
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null, durationMs: null });
    };
    video.src = url;
  });
}

/**
 * 上传一份媒体文件并登记为资产。
 *
 * @param supabase - 浏览器端 Supabase 客户端
 * @param params - 上传参数
 * @returns 带签名 URL 的资产视图
 * @throws 当上传或登记失败时抛出
 */
export async function uploadAsset(
  supabase: TypedSupabaseClient,
  params: UploadAssetParams,
): Promise<AssetView> {
  const { file, userId, projectId, isAuxiliary = false, onProgress } = params;
  if (isAuxiliary && !projectId) {
    throw new Error('辅助资产必须关联项目');
  }
  const kind = kindFromMime(file.type);
  const assetId = uuid();
  const ext = extFromFile(file);
  const folder = isAuxiliary ? `${projectId}/edit-inputs` : (projectId ?? 'loose');
  const path = `${userId}/${folder}/${assetId}.${ext}`;

  onProgress?.(0.05);

  const meta = kind === 'video' ? await probeVideo(file) : await probeImage(file);

  const { error: uploadError } = await supabase.storage.from(UPLOADS_BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (uploadError) {
    throw new Error(`上传失败：${uploadError.message}`);
  }

  onProgress?.(0.8);

  const { data: row, error: insertError } = await supabase
    .from('assets')
    .insert({
      id: assetId,
      owner_id: userId,
      project_id: projectId ?? null,
      kind,
      source: 'upload',
      storage_bucket: UPLOADS_BUCKET,
      storage_path: path,
      mime_type: file.type || 'application/octet-stream',
      width: meta.width,
      height: meta.height,
      duration_ms: meta.durationMs,
      size_bytes: file.size,
      is_auxiliary: isAuxiliary,
    })
    .select()
    .single();

  if (insertError || !row) {
    // 登记失败则回滚已上传对象，避免孤儿
    await supabase.storage.from(UPLOADS_BUCKET).remove([path]);
    throw new Error(`资产登记失败：${insertError?.message ?? '未知错误'}`);
  }

  onProgress?.(1);

  return resolveAssetView(supabase, row);
}

/** 删除尚未被 generation 引用的编辑辅助资产参数。 */
export interface DeleteAuxiliaryAssetParams {
  /** 辅助资产标识。 */
  assetId: string;
  /** 必须与资产关联项目一致，防止误删其他项目资源。 */
  projectId: string;
}

/**
 * 清理一次被取消编辑会话创建、且尚未进入生成输入血缘的辅助资产。
 *
 * 删除前同时验证 `is_auxiliary`、项目归属和不存在 `generation_inputs` 引用；任一条件不满足
 * 都保持资产不变。先删除 Storage 对象再删除行，避免留下无法定位的对象。
 */
export async function deleteUnreferencedAuxiliaryAsset(
  supabase: TypedSupabaseClient,
  params: DeleteAuxiliaryAssetParams,
): Promise<boolean> {
  const { data: asset, error: assetError } = await supabase
    .from('assets')
    .select('id, project_id, storage_bucket, storage_path, is_auxiliary')
    .eq('id', params.assetId)
    .maybeSingle();
  if (assetError) throw new Error(`辅助资产查询失败：${assetError.message}`);
  if (!asset || !asset.is_auxiliary || asset.project_id !== params.projectId) return false;

  const { count, error: referenceError } = await supabase
    .from('generation_inputs')
    .select('generation_id', { count: 'exact', head: true })
    .eq('asset_id', params.assetId);
  if (referenceError) throw new Error(`辅助资产引用检查失败：${referenceError.message}`);
  if ((count ?? 0) > 0) return false;

  const { error: storageError } = await supabase.storage
    .from(asset.storage_bucket)
    .remove([asset.storage_path]);
  if (storageError) throw new Error(`辅助对象清理失败：${storageError.message}`);

  const { error: deleteError } = await supabase.from('assets').delete().eq('id', params.assetId);
  if (deleteError) throw new Error(`辅助资产清理失败：${deleteError.message}`);
  return true;
}

/** {@link uploadAvatar} 的结果：公开 URL 与其在桶内的存储路径（便于后续清理）。 */
export interface UploadedAvatar {
  /** 可直接用于 `<img src>` 的公开访问地址。 */
  url: string;
  /** 对象在 `avatars` 桶内的相对路径。 */
  path: string;
}

/**
 * 上传用户头像到公开 `avatars` 桶，返回可直接展示的公开 URL。
 *
 * 路径首段为用户 id，满足存储 RLS（`avatars_insert_own`：仅本人可写自身目录）。
 * 文件名带随机 id，避免浏览器缓存旧头像；不复用 `assets` 表登记（头像是档案字段，
 * 非画布资产）。
 *
 * @param supabase - 浏览器端 Supabase 客户端
 * @param userId - 当前用户标识（路径首段）
 * @param file - 待上传图片文件
 * @returns 公开 URL 与存储路径
 * @throws 当上传失败时抛出
 */
export async function uploadAvatar(
  supabase: TypedSupabaseClient,
  userId: string,
  file: File,
): Promise<UploadedAvatar> {
  const ext = extFromFile(file);
  const path = `${userId}/avatar-${uuid()}.${ext}`;
  const { error } = await supabase.storage.from(AVATARS_BUCKET).upload(path, file, {
    contentType: file.type || 'image/png',
    upsert: false,
  });
  if (error) {
    throw new Error(`头像上传失败：${error.message}`);
  }
  const { data } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path };
}
