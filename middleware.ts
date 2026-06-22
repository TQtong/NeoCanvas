/**
 * Next.js 中间件：在请求边界刷新 Supabase 会话并实施受保护路由（第 04 篇第八节）。
 *
 * @module middleware
 */

import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * 中间件入口。
 *
 * @param request - 进入的请求
 * @returns 携带刷新后会话 Cookie 的响应（或重定向）
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

/**
 * 匹配除静态资源外的全部路径。
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
