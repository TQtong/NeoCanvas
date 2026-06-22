/**
 * 本地化格式化工具：日期、数字、文件大小、时长。
 *
 * 尊重界面草图的中英混排：日期按区域格式化（如「更新于 Jun 22, 2026」），数字与
 * 大小同理。具体语言由调用方传入 locale（来自 profiles.locale）。
 *
 * @module lib/utils/format
 */

/**
 * 把 ISO 时间格式化为「更新于 Mon DD, YYYY」风格的可读日期。
 *
 * @param iso - ISO 时间字符串
 * @param locale - BCP 47 语言标签（如 'zh-CN'、'en'）
 * @returns 可读日期串；输入无效时返回空串
 */
export function formatUpdatedDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * 相对时间格式化（如「3 分钟前」/「3 minutes ago」），超过 7 天回退为绝对日期。
 *
 * @param iso - ISO 时间字符串
 * @param locale - 语言标签
 * @returns 相对或绝对时间串
 */
export function formatRelativeTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en', {
    numeric: 'auto',
  });
  if (absSec < 60) return rtf.format(Math.round(diffSec), 'second');
  if (absSec < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (absSec < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (absSec < 604800) return rtf.format(Math.round(diffSec / 86400), 'day');
  return formatUpdatedDate(iso, locale);
}

/**
 * 把字节数格式化为可读大小（KB/MB/GB）。
 *
 * @param bytes - 字节数
 * @returns 可读大小串
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/**
 * 把毫秒时长格式化为 m:ss。
 *
 * @param ms - 毫秒
 * @returns 形如 1:05 的时长串
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/**
 * 把缩放比格式化为百分比整数串（如 1 → "100%"）。
 *
 * @param zoom - 缩放比
 * @returns 百分比串
 */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
