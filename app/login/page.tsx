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

/**
 * 登录页组件。
 *
 * @param props - 查询参数（redirect 回跳地址）
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect: redirectParam } = await searchParams;
  const redirectTo = redirectParam && redirectParam.startsWith('/') ? redirectParam : '/';

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    redirect(redirectTo);
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6">
      <LoginForm redirectTo={redirectTo} />
    </main>
  );
}
