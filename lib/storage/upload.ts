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

/** 上传参数。 */
export interface UploadAssetParams {
  /** 待上传文件。 */
  file: File;
  /** 上传者用户标识（路径首段）。 */
  userId: string;
  /** 关联项目（可空，路径次段；无项目时归入 loose）。 */
  projectId?: string | null;
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
  const { file, userId, projectId, onProgress } = params;
  const kind = kindFromMime(file.type);
  const assetId = uuid();
  const ext = extFromFile(file);
  const folder = projectId ?? 'loose';
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
