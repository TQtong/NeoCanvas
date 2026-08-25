/** Provider webhook 的签名、时间戳与事件摘要校验。 */

import { sha256Hex } from './request-hash.ts';

/** 候选签名头（不同 Provider 命名各异）。 */
const SIGNATURE_HEADERS = ['x-webhook-signature', 'x-signature', 'x-hub-signature-256'];
const TIMESTAMP_HEADERS = ['x-webhook-timestamp', 'x-timestamp'];
/** 最大重放窗口：五分钟。 */
export const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** webhook 校验所需的最小 generation 投影。 */
export interface WebhookGenerationAuth {
  provider: string;
  webhookSecretHash: string | null;
  webhookSecretExpiresAt: string | null;
}

/** 常数时间字符串比较。 */
export function timingSafeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/** 读取第一个存在的请求头。 */
function firstHeader(request: Request, names: string[]): string | null {
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) return value;
  }
  return null;
}

/** 把秒/毫秒 Unix 时间戳或 ISO 时间解析为毫秒。 */
export function parseWebhookTimestamp(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return value.length <= 10 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 十六进制编码。 */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 校验 Provider HMAC 或每任务回调 secret，并强制重放窗口。
 * Provider HMAC 的签名内容固定为 `${timestamp}.${rawBody}`。
 */
export async function verifyGenerationWebhookSignature(
  request: Request,
  rawBody: string,
  generation: WebhookGenerationAuth,
  now = Date.now(),
): Promise<{ valid: boolean; timestamp: string | null }> {
  const timestamp = firstHeader(request, TIMESTAMP_HEADERS);
  const timestampMs = timestamp ? parseWebhookTimestamp(timestamp) : null;
  if (timestampMs == null || Math.abs(now - timestampMs) > WEBHOOK_REPLAY_WINDOW_MS) {
    return { valid: false, timestamp };
  }

  const providerEnv = generation.provider.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_');
  const providerSecret = Deno.env.get(`GENERATION_WEBHOOK_SECRET_${providerEnv}`) ??
    Deno.env.get('GENERATION_WEBHOOK_SECRET');
  const providedSignature = firstHeader(request, SIGNATURE_HEADERS);
  if (providerSecret && providedSignature) {
    const signature = (
      providedSignature.startsWith('sha256=') ? providedSignature.slice(7) : providedSignature
    ).toLowerCase();
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(providerSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${rawBody}`),
    );
    if (timingSafeEqual(signature, toHex(mac))) return { valid: true, timestamp };
  }

  const taskSecret = request.headers.get('x-generation-callback-secret');
  const expiresAt = generation.webhookSecretExpiresAt
    ? Date.parse(generation.webhookSecretExpiresAt)
    : Number.NaN;
  if (
    taskSecret &&
    generation.webhookSecretHash &&
    Number.isFinite(expiresAt) &&
    now <= expiresAt &&
    timingSafeEqual(await sha256Hex(taskSecret), generation.webhookSecretHash)
  ) {
    return { valid: true, timestamp };
  }
  return { valid: false, timestamp };
}

/** 没有 Provider event id 时，以已签名时间戳和原始正文生成稳定重放键。 */
export function webhookEventKey(
  timestamp: string,
  rawBody: string,
  providerEventId?: string | null,
): Promise<string> {
  return providerEventId ? Promise.resolve(providerEventId) : sha256Hex(`${timestamp}.${rawBody}`);
}
