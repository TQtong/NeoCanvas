/**
 * Supabase 客户端的强类型别名。
 *
 * 直接由 `@supabase/ssr` 的浏览器工厂返回类型推导，确保与所安装的 supabase-js 版本的
 * 泛型签名严格一致（避免手写 `SupabaseClient<Database>` 与库版本签名漂移）。三种客户端
 * 形态（浏览器 / 服务端 / 中间件）共享同一套列级类型约束。
 *
 * @module lib/supabase/types
 */

import type { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/types';

/** 本项目强类型 Supabase 客户端（以浏览器工厂返回类型为准）。 */
export type TypedSupabaseClient = ReturnType<typeof createBrowserClient<Database>>;

export type { Database };
