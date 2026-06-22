/**
 * OAuth / 魔法链接回调路由（第 04 篇第八节）。
 *
 * 处理认证回跳：用授权码换取会话写入 Cookie，随后重定向到目标地址（或主页）。
 *
 * @module app/auth/callback/route
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';

/**
 * 处理认证回调 GET 请求。
 *
 * @param request - 进入的请求（含 code 与可选 redirect）
 * @returns 重定向响应
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const redirectTo = searchParams.get('redirect') ?? '/';

  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${redirectTo}`);
    }
  }

  // 失败回登录页并提示
  return NextResponse.redirect(`${origin}/login?error=auth`);
}
