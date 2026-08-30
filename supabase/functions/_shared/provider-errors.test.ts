import { ApiException } from './response.ts';
import { isProviderTransportError, normalizeProviderError } from './provider-errors.ts';

Deno.test('TLS 握手中断被归一为可退避 Provider 错误且不向用户暴露 URL', () => {
  const raw = new TypeError(
    'error sending request for url (https://api.example.com/v1/images): client error (Connect): tls handshake eof',
  );
  if (!isProviderTransportError(raw)) throw new Error('未识别 TLS 传输错误');

  const normalized = normalizeProviderError(raw, 'siliconflow');
  if (normalized.code !== 'provider_error' || !normalized.retryable) {
    throw new Error('传输错误没有进入 Provider 退避分支');
  }
  if (normalized.message.includes('https://') || !normalized.diagnostic.includes('tls handshake')) {
    throw new Error('用户消息与技术诊断没有正确隔离');
  }
});

Deno.test('已归一业务错误保持原错误码，普通代码异常保持 internal_error', () => {
  const rateLimited = normalizeProviderError(
    new ApiException('rate_limited', '请求过于频繁'),
    'siliconflow',
  );
  if (rateLimited.code !== 'rate_limited' || !rateLimited.retryable) {
    throw new Error('稳定业务错误被错误改写');
  }

  const programmingError = normalizeProviderError(new Error('unexpected state'), 'siliconflow');
  if (programmingError.code !== 'internal_error' || programmingError.retryable) {
    throw new Error('普通代码异常不应伪装成 Provider 网络错误');
  }
});
