'use client';

/**
 * 能力面（Edge Functions）调用封装。
 *
 * 统一处理鉴权（携带用户 JWT）、响应封套解包与错误归一。提供两种调用：常规 JSON
 * 调用（{@link invokeEdge}）与流式调用（{@link invokeEdgeStream}，用于 agent-orchestrate
 * 的边生成边显示）。
 *
 * @module lib/edge/client
 */

import type { ApiResponse } from '@/types';
import { getPublicEnv } from '@/lib/env';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { ApiClientError, fromEdgeInvokeError } from './errors';

/**
 * 调用一个返回统一封套的 Edge Function。
 *
 * @typeParam TReq - 请求体类型
 * @typeParam TRes - 成功数据类型
 * @param fnName - 函数逻辑名
 * @param body - 请求体
 * @returns 成功数据
 * @throws {ApiClientError} 当函数返回失败封套或网络出错时
 */
export async function invokeEdge<TReq, TRes>(fnName: string, body: TReq): Promise<TRes> {
  const supabase = getBrowserSupabase();
  const { data, error } = await supabase.functions.invoke<ApiResponse<TRes>>(fnName, {
    body: body as Record<string, unknown>,
  });

  if (error) {
    // 从 FunctionsHttpError.context 恢复结构化错误码，避免塌缩为 internal_error
    throw await fromEdgeInvokeError(error);
  }
  if (!data) {
    throw new ApiClientError({ code: 'internal_error', message: '函数无响应' });
  }
  if (!data.success) {
    throw new ApiClientError(data.error);
  }
  return data.data;
}

/**
 * 以流式方式调用一个 Edge Function，逐块解析 SSE 事件。
 *
 * @typeParam TEvent - 事件类型
 * @param fnName - 函数逻辑名
 * @param body - 请求体
 * @returns 异步事件迭代器
 * @throws {ApiClientError} 当鉴权缺失或网络出错时
 */
export async function* invokeEdgeStream<TEvent>(
  fnName: string,
  body: unknown,
): AsyncGenerator<TEvent, void, unknown> {
  const supabase = getBrowserSupabase();
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new ApiClientError({ code: 'unauthorized', message: '登录态失效，请重新登录' });
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const message = `请求失败（${response.status}）`;
    try {
      const payload = (await response.json()) as ApiResponse<never>;
      if (!payload.success) {
        throw new ApiClientError(payload.error);
      }
    } catch (err) {
      if (err instanceof ApiClientError) throw err;
    }
    throw new ApiClientError({ code: 'provider_error', message });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 以双换行分割 SSE 事件块
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data:'));
      if (dataLine) {
        const json = dataLine.slice('data:'.length).trim();
        if (json && json !== '[DONE]') {
          yield JSON.parse(json) as TEvent;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
