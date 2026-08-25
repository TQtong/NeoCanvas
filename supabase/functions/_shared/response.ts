/**
 * 统一响应封套与 CORS 助手（第 06 篇第五节）。
 *
 * 所有面向客户端的 Edge Function 返回统一封套：成功携带数据对象，失败携带稳定错误码、
 * 可本地化消息与可选细节。
 *
 * @module functions/_shared/response
 */

import { type ApiError, type ApiResponse, ERROR_HTTP_STATUS, type ErrorCode } from './types.ts';

/** CORS 头：允许浏览器跨源调用能力面。 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** 处理 CORS 预检请求。 */
export function handleCorsPreflight(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  return null;
}

/** 构造成功响应。 */
export function ok<T>(data: T, status = 200): Response {
  const body: ApiResponse<T> = { success: true, data };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** 构造失败响应。 */
export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const error: ApiError = { code, message, details };
  const body: ApiResponse<never> = { success: false, error };
  return new Response(JSON.stringify(body), {
    status: ERROR_HTTP_STATUS[code],
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** 业务错误：携带错误码，便于在流水线中抛出并由入口统一转封套。 */
export class ApiException extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiException';
    this.code = code;
    this.details = details;
  }
}

/** 把异常转为失败响应。 */
export function exceptionToResponse(error: unknown): Response {
  if (error instanceof ApiException) {
    return fail(error.code, error.message, error.details);
  }
  const message = error instanceof Error ? error.message : '服务端内部错误';
  return fail('internal_error', message);
}
