'use client';

/**
 * 浏览器端 Supabase 客户端工厂。
 *
 * 在客户端组件中使用，持有用户会话（经 Cookie），用于数据面直连读写、Storage 访问
 * 与 Realtime 订阅。匿名公钥本身不授予权限，真正的权限来自登录后的用户 JWT + RLS。
 *
 * @module lib/supabase/client
 */

import { createBrowserClient } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types';
import type { TypedSupabaseClient } from './types';

let cached: TypedSupabaseClient | null = null;

/**
 * 获取（并在首次时创建）浏览器端 Supabase 客户端单例。
 *
 * 单例化可避免重复创建导致的多份 Realtime 连接与 Auth 监听。
 *
 * @returns 浏览器端强类型 Supabase 客户端
 */
export function getBrowserSupabase(): TypedSupabaseClient {
  if (cached) return cached;
  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();
  const client = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
  cached = client;

  // 把登录用户的 JWT 绑定到 Realtime WebSocket：Realtime 的 postgres_changes 以「订阅者
  // 角色」逐行做 RLS 授权，socket 必须携带 authenticated 的用户 JWT，否则以 anon 连接，
  // 而本项目的行级策略经 `private.is_project_owner` 判定（anon 无 private 模式权限）会逐行
  // 授权失败 —— 频道状态显示 SUBSCRIBED 却收不到任何变更（画布空白、对话卡在「生成中」）。
  //
  // supabase-js 默认只在 SIGNED_IN / TOKEN_REFRESHED 时回补 realtime 鉴权；而带 Cookie 的
  // 页面刷新触发的是 INITIAL_SESSION（不被回补）。故此处显式：会话恢复 / 变更时主动 setAuth，
  // 并立即用当前会话同步一次，保证后续订阅以 authenticated 身份建立。
  client.auth.onAuthStateChange((_event, session) => {
    void client.realtime.setAuth(session?.access_token ?? null);
  });
  void client.auth.getSession().then(({ data }) => {
    void client.realtime.setAuth(data.session?.access_token ?? null);
  });

  return client;
}
