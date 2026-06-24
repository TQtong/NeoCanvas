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
  const redirectParam = searchParams.get('redirect');
  // 开放重定向防护：origin 与 redirect 直接拼接，仅以单个 `/` 开头的站内路径才安全。
  // 形如 `@evil.com`、`//evil.com`、`https://evil.com` 的取值会逃逸出本站 origin，一律回退到主页。
  const redirectTo =
    redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
      ? redirectParam
      : '/';

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
