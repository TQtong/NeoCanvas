/**
 * 登录页（第 04 篇第八节）。已登录则重定向到目标地址。
 *
 * @module app/login/page
 */

import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { LoginForm } from '@/components/auth/LoginForm';

/** 登录页不缓存。 */
export const dynamic = 'force-dynamic';

/** 认证回调失败码 → 可读提示（回调路由失败时回跳 `/login?error=...`）。 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  auth: '登录未能完成，请重试。如多次失败，请确认浏览器允许第三方 Cookie 后再试。',
};

/**
 * 登录页组件。
 *
 * @param props - 查询参数（redirect 回跳地址、error 回调失败码）
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const { redirect: redirectParam, error: errorParam } = await searchParams;
  const redirectTo =
    redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
      ? redirectParam
      : '/';
  const initialError = errorParam
    ? (AUTH_ERROR_MESSAGES[errorParam] ?? '登录失败，请重试')
    : undefined;

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    redirect(redirectTo);
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6">
      <LoginForm redirectTo={redirectTo} initialError={initialError} />
    </main>
  );
}
