/** 生成提交的规范化幂等摘要。 */

import { type UnifiedGenerationRequest } from './types.ts';

/** 把对象递归规范为键稳定的 JSON 值。 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/** 对字符串计算 SHA-256 十六进制。 */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 计算不含客户端临时占位 id 的生成请求语义摘要。 */
export function generationRequestHash(request: UnifiedGenerationRequest): Promise<string> {
  const semanticRequest = {
    projectId: request.projectId,
    conversationId: request.conversationId,
    messageId: request.messageId,
    modality: request.modality,
    modelKey: request.modelKey,
    prompt: request.prompt,
    params: request.params,
    placement: request.placement ?? null,
    targetNodeId: request.targetNodeId ?? null,
    resultMode: request.resultMode ?? 'new_primary',
  };
  return sha256Hex(JSON.stringify(canonicalize(semanticRequest)));
}
