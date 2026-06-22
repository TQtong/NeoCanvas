/**
 * 中间件 Supabase 客户端与会话刷新。
 *
 * Next.js 中间件在请求边界统一刷新令牌并把刷新后的 Cookie 写回响应，使服务端组件、
 * 服务端动作与客户端三处的会话保持一致（第 04 篇第八节）。同时实现受保护路由的
 * 未登录重定向。
 *
 * @module lib/supabase/middleware
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/env';
import type { Database } from '@/types';

/** 无需登录即可访问的路径前缀。 */
const PUBLIC_PATHS = ['/login', '/auth', '/_next', '/favicon', '/api/health'];

/**
 * 判断路径是否公开（无需登录）。
 *
 * @param pathname - 请求路径
 * @returns 是否公开
 */
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p));
}

/**
 * 在中间件中刷新会话并实施受保护路由重定向。
 *
 * @param request - 进入的请求
 * @returns 携带刷新后 Cookie 的响应（或重定向响应）
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const { supabaseUrl, supabaseAnonKey } = getPublicEnv();

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // 同步写入请求与新响应，确保后续读取与下游都拿到刷新后的会话
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // 触发令牌刷新并取得当前用户
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // 未登录访问受保护路由 → 重定向到登录页，并携带回跳地址
  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('redirect', pathname + request.nextUrl.search);
    return NextResponse.redirect(redirectUrl);
  }

  // 已登录访问登录页 → 重定向到主页
  if (user && pathname === '/login') {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
