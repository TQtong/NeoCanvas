import 'server-only';

/**
 * 服务端 Supabase 客户端工厂。
 *
 * 在服务端组件、服务端动作（Server Action）、路由处理器中使用，经 Next.js 的
 * `cookies()` 持有用户会话，从而在 RSC 直出与服务端写入时建立正确的 RLS 上下文。
 *
 * @module lib/supabase/server
 */

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getPublicEnv, getServerSupabaseUrl, getSupabaseAuthCookieName } from '@/lib/env';
import type { Database } from '@/types';
import type { TypedSupabaseClient } from './types';

/**
 * 创建一个绑定当前请求 Cookie 的服务端 Supabase 客户端。
 *
 * 在服务端组件中写 Cookie 受 Next 限制（只读上下文），此处对写操作做容错：服务端
 * 组件渲染期间的 set 调用被静默忽略，令牌刷新由中间件统一处理（见 middleware.ts）。
 *
 * @returns 服务端强类型 Supabase 客户端
 */
export async function createServerSupabase(): Promise<TypedSupabaseClient> {
  const { supabaseAnonKey } = getPublicEnv();
  const supabaseUrl = getServerSupabaseUrl();
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookieOptions: { name: getSupabaseAuthCookieName() },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // 在服务端组件中调用 set 会抛错；令牌刷新交由中间件，此处可安全忽略。
        }
      },
    },
  });
}
