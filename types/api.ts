/**
 * 能力面统一响应封套与错误码契约（第 06 篇第五节）。
 *
 * 能力面（Edge Functions）的所有函数返回统一封套，使客户端以一致方式处理成败；
 * 数据面（PostgREST）的错误在数据访问层被归一为同一套错误码语义。错误码稳定且与
 * 展示文案解耦：码用于客户端分支与埋点，文案随用户语言本地化。
 *
 * @module types/api
 */

/**
 * 稳定的机器可读错误码族。
 */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'invalid_params',
  'unsupported_param',
  'not_found',
  'content_blocked',
  'model_unavailable',
  'model_not_accessible',
  'provider_error',
  'provider_signature_invalid',
  'generation_timeout',
  'generation_terminal',
  'duplicate_request',
  'idempotency_conflict',
  'project_forbidden',
  'internal_auth_required',
  'conflict',
  'rate_limited',
  'internal_error',
] as const;

/** 错误码字面量联合。 */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 错误负载。`message` 可向用户展示且可本地化；`details` 为可选细节。
 */
export interface ApiError {
  /** 稳定错误码。 */
  code: ErrorCode;
  /** 可展示、可本地化的消息。 */
  message: string;
  /** 可选细节（如校验失败字段、提供商原始错误摘要）。 */
  details?: Record<string, unknown>;
}

/**
 * 成功响应封套。
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

/**
 * 失败响应封套。
 */
export interface ApiFailure {
  success: false;
  error: ApiError;
}

/**
 * 统一响应封套：成功携带数据对象，失败携带错误。
 */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/**
 * 把错误码映射到 HTTP 状态，用于 Edge Function 返回与数据面错误归一。
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_params: 400,
  unsupported_param: 400,
  not_found: 404,
  content_blocked: 422,
  model_unavailable: 409,
  model_not_accessible: 403,
  provider_error: 502,
  provider_signature_invalid: 401,
  generation_timeout: 504,
  generation_terminal: 409,
  duplicate_request: 200,
  idempotency_conflict: 409,
  project_forbidden: 403,
  internal_auth_required: 401,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};
