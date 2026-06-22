/**
 * 媒体签名 URL 解析。
 *
 * 私有桶（uploads / generations）的对象一律经短时效签名 URL 访问（第 03 篇第六节）。
 * 缩略图优先用 `assets.thumbnail_path`；缺失且为图片时借助 Storage 图片变换在读取时
 * 即时生成（transform 宽度）。
 *
 * @module lib/storage/signed-url
 */

import type { AssetRow, AssetView } from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';

/** 签名 URL 默认有效期（秒）：1 小时。 */
export const SIGNED_URL_TTL = 3600;

/** 缩略图变换的目标宽度（px）。 */
export const THUMBNAIL_WIDTH = 480;

/**
 * 为单个对象创建签名 URL。
 *
 * @param supabase - Supabase 客户端
 * @param bucket - 存储桶
 * @param path - 桶内路径
 * @param expiresIn - 有效期（秒）
 * @param transformWidth - 可选图片变换宽度（缩略图）
 * @returns 签名 URL；失败返回 null
 */
export async function createSignedUrl(
  supabase: TypedSupabaseClient,
  bucket: string,
  path: string,
  expiresIn: number = SIGNED_URL_TTL,
  transformWidth?: number,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn, transformWidth ? { transform: { width: transformWidth } } : undefined);
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * 把一条资产行解析为带访问 URL 的视图。
 *
 * @param supabase - Supabase 客户端
 * @param row - 资产行
 * @param expiresIn - 有效期（秒）
 * @returns 资产视图；URL 解析失败时 url 为空串
 */
export async function resolveAssetView(
  supabase: TypedSupabaseClient,
  row: AssetRow,
  expiresIn: number = SIGNED_URL_TTL,
): Promise<AssetView> {
  const url = (await createSignedUrl(supabase, row.storage_bucket, row.storage_path, expiresIn)) ?? '';

  let thumbnailUrl: string | null = null;
  if (row.thumbnail_path) {
    thumbnailUrl = await createSignedUrl(supabase, row.storage_bucket, row.thumbnail_path, expiresIn);
  } else if (row.kind === 'image') {
    thumbnailUrl = await createSignedUrl(
      supabase,
      row.storage_bucket,
      row.storage_path,
      expiresIn,
      THUMBNAIL_WIDTH,
    );
  }

  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    url,
    thumbnailUrl,
  };
}

/**
 * 批量解析多条资产视图（逐条创建签名 URL；同桶可并发）。
 *
 * @param supabase - Supabase 客户端
 * @param rows - 资产行集合
 * @param expiresIn - 有效期（秒）
 * @returns 资产视图数组（按输入顺序）
 */
export async function resolveAssetViews(
  supabase: TypedSupabaseClient,
  rows: AssetRow[],
  expiresIn: number = SIGNED_URL_TTL,
): Promise<AssetView[]> {
  return Promise.all(rows.map((row) => resolveAssetView(supabase, row, expiresIn)));
}
