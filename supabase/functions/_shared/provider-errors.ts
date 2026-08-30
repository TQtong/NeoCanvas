/**
 * Provider 执行错误归一化。
 *
 * Deno `fetch` 在 DNS、TCP、TLS 等传输阶段失败时只抛出不带业务 `code` 的 `TypeError`。
 * 队列必须把这类错误识别为可退避的 `provider_error`，否则一次瞬时握手中断就会错误地
 * 把生成任务提交为不可重试的 `internal_error`。
 *
 * @module functions/_shared/provider-errors
 */

import { type ErrorCode, type Provider } from './types.ts';
import { ApiException } from './response.ts';

/** 归一化后供队列状态机消费的稳定错误。 */
export interface NormalizedProviderError {
  code: ErrorCode;
  message: string;
  diagnostic: string;
  retryable: boolean;
}

/** 明确属于网络传输阶段的错误特征，不把普通代码异常伪装成 Provider 故障。 */
const TRANSPORT_ERROR_PATTERN =
  /error sending request for url|fetch failed|network error|client error \(connect\)|tls handshake|connection (?:reset|refused|closed)|dns error|name resolution|socket hang up/i;

/** 判断异常是否由 Provider 请求的 DNS、连接或 TLS 层产生。 */
export function isProviderTransportError(error: unknown): boolean {
  if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) {
    return true;
  }
  return error instanceof TypeError && TRANSPORT_ERROR_PATTERN.test(error.message);
}

/**
 * 将适配器抛出的未知异常转换为共享错误码，同时保留仅写日志的技术诊断。
 * 用户可见消息不得包含带查询参数的外部 URL 或运行时内部实现细节。
 */
export function normalizeProviderError(
  error: unknown,
  provider: Provider,
): NormalizedProviderError {
  if (error instanceof ApiException) {
    return {
      code: error.code,
      message: error.message,
      diagnostic: error.message,
      retryable: error.code === 'provider_error' || error.code === 'rate_limited',
    };
  }

  const diagnostic = error instanceof Error ? error.message : String(error);
  if (isProviderTransportError(error)) {
    return {
      code: 'provider_error',
      message: `${provider} 网络连接暂时失败，系统已自动退避重试`,
      diagnostic,
      retryable: true,
    };
  }

  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : '执行失败',
    diagnostic,
    retryable: false,
  };
}
