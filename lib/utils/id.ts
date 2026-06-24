/**
 * 客户端标识生成工具。
 *
 * 用于生成幂等键、客户端请求标识、乐观更新的临时回声标记等。持久实体的主键由
 * 数据库以 UUID 默认值生成，此处仅用于客户端在途标识。
 *
 * @module lib/utils/id
 */

/**
 * 生成一个 UUID v4。优先使用平台原生 `crypto.randomUUID`，在缺失时回退到基于
 * `crypto.getRandomValues` 的实现，确保浏览器与边缘运行时下均可用。
 *
 * @returns 形如 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` 的 UUID 字符串
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 回退实现：填充随机字节并按 RFC 4122 设置版本 / 变体位
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * 生成一个幂等键。语义上等同于 {@link uuid}，独立命名以表达用途。
 *
 * @returns 幂等键
 */
export function idempotencyKey(): string {
  return uuid();
}
