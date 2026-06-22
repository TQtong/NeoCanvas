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
  cached = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
  return cached;
}
