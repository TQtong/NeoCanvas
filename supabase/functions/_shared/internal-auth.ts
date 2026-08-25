/**
 * 内部 Edge Function 的 service-role 入口鉴权。
 *
 * `verify_jwt = false` 只用于允许 pg_cron 直达函数，绝不代表匿名可执行。这里对 Bearer
 * token 与环境中的 service-role key 做恒定时间比较，且错误与日志均不回显任何凭据。
 *
 * @module functions/_shared/internal-auth
 */

import { ApiException } from './response.ts';

/** 对 UTF-8 字节做长度隐藏的恒定次数比较。 */
function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * 强制要求请求携带当前部署的 service-role Bearer token。
 *
 * @param request - Edge Function 原始请求
 * @throws {ApiException} 缺失、格式错误、普通用户 JWT 或错误 service-role 均拒绝
 */
export function requireInternalServiceRole(request: Request): void {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!expected) {
    throw new ApiException('internal_error', '内部鉴权未配置');
  }
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match || !timingSafeEqual(match[1], expected)) {
    throw new ApiException('internal_auth_required', '仅允许内部服务调用');
  }
}
