/**
 * 错误归一：把数据面（PostgREST）与能力面（Edge Functions）的错误统一为同一套
 * 错误码语义，使上层无须区分错误来源（第 06 篇第五节）。
 *
 * @module lib/edge/errors
 */

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import type { ApiError, ApiResponse, ErrorCode } from '@/types';
import { ERROR_CODES } from '@/types';

/**
 * 客户端侧的统一错误对象。携带稳定错误码、可展示消息与可选细节。
 */
export class ApiClientError extends Error {
  /** 稳定错误码。 */
  public readonly code: ErrorCode;
  /** 可选细节。 */
  public readonly details?: Record<string, unknown>;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiClientError';
    this.code = error.code;
    this.details = error.details;
  }
}

/** 判断是否为已知错误码。 */
function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** 判断对象是否为 ApiClientError。 */
export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

/**
 * 由 PostgREST / supabase-js 错误归一为 ApiClientError。
 *
 * @param error - supabase-js 抛出的错误对象（含 code / message / status）
 * @returns 归一后的 ApiClientError
 */
export function fromSupabaseError(error: {
  code?: string;
  message?: string;
  status?: number;
  details?: string;
}): ApiClientError {
  const status = error.status;
  const pgCode = error.code;
  let code: ErrorCode = 'internal_error';

  if (status === 401) code = 'unauthorized';
  else if (status === 403 || pgCode === '42501') code = 'forbidden';
  else if (status === 404 || pgCode === 'PGRST116') code = 'not_found';
  else if (status === 409 || pgCode === '23505') code = 'conflict';
  else if (status === 429) code = 'rate_limited';
  else if (status === 400 || pgCode === '23514' || pgCode === '23502') code = 'invalid_params';

  return new ApiClientError({
    code,
    message: error.message ?? '请求失败，请稍后重试',
    details: error.details ? { pg: error.details } : undefined,
  });
}

/**
 * 由 supabase-js `functions.invoke` 抛出的错误恢复稳定错误码。
 *
 * 非 2xx 响应时 functions-js 抛出 {@link FunctionsHttpError}，其结构化失败封套
 * （含稳定 code 与可展示 message）只存在于 `error.context`（一个 Response）中，必须读取
 * 才能拿到真实错误码；否则会塌缩为 internal_error，使第 06 篇第五节要求的「按错误码分支
 * 处置」无法触发。网络 / 网关类错误映射为 provider_error。
 *
 * @param error - functions.invoke 返回的 error
 * @returns 归一后的 ApiClientError
 */
export async function fromEdgeInvokeError(error: unknown): Promise<ApiClientError> {
  if (isApiClientError(error)) return error;

  if (error instanceof FunctionsHttpError) {
    // 结构化封套在 context（Response）里，且响应体只能读取一次
    try {
      const payload = (await error.context.json()) as ApiResponse<never>;
      if (payload && payload.success === false && payload.error) {
        return new ApiClientError(payload.error);
      }
    } catch {
      // 响应体非 JSON / 为空 → 落到兜底
    }
    return new ApiClientError({
      code: 'internal_error',
      message: 'Edge 函数返回非 2xx 且无可解析的错误封套',
    });
  }

  if (error instanceof FunctionsFetchError) {
    return new ApiClientError({ code: 'provider_error', message: '网络异常，请稍后重试' });
  }
  if (error instanceof FunctionsRelayError) {
    return new ApiClientError({ code: 'provider_error', message: '边缘网关异常，请稍后重试' });
  }

  return normalizeUnknownError(error);
}

/**
 * 由任意未知错误兜底归一。
 *
 * @param error - 未知错误
 * @returns ApiClientError
 */
export function normalizeUnknownError(error: unknown): ApiClientError {
  if (isApiClientError(error)) return error;
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (isErrorCode(candidate.code)) {
      return new ApiClientError({
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message : '请求失败',
      });
    }
  }
  return new ApiClientError({
    code: 'internal_error',
    message: error instanceof Error ? error.message : '发生未知错误',
  });
}
