'use client';

/**
 * 登录表单（第 04 篇第八节）。
 *
 * 提供邮箱魔法链接与第三方 OAuth 登录入口。魔法链接经 signInWithOtp 发送；OAuth 经
 * 回调路由完成换取会话。登录成功后回跳到来源地址或主页。
 *
 * @module components/auth/LoginForm
 */

import { useState } from 'react';
import { Mail, Sparkles } from 'lucide-react';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { getPublicEnv } from '@/lib/env';
import { Button } from '@/components/ui/button';

/** 登录表单属性。 */
export interface LoginFormProps {
  /** 登录成功后的回跳路径。 */
  redirectTo: string;
  /** 初始错误提示（如认证回调失败回跳时携带）。 */
  initialError?: string;
}

/**
 * 登录表单组件。
 */
export function LoginForm({ redirectTo, initialError }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const callbackUrl = () => {
    const { siteUrl } = getPublicEnv();
    return `${siteUrl}/auth/callback?redirect=${encodeURIComponent(redirectTo)}`;
  };

  const onMagicLink = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    setError(null);
    try {
      const { error: otpError } = await getBrowserSupabase().auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: callbackUrl() },
      });
      if (otpError) throw otpError;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试');
    } finally {
      setSending(false);
    }
  };

  const onOAuth = async () => {
    setError(null);
    // PKCE 流程需用 Web Crypto（crypto.subtle）计算 code challenge，而它仅在安全上下文可用：
    // HTTPS、或 localhost / 127.0.0.1。经局域网 IP 等非安全来源以明文 HTTP 访问时其为
    // undefined，signInWithOAuth 会在跳转前抛错。此处先行拦截并给出可操作提示，避免未捕获
    // 的 Promise 拒绝直接打崩页面（这正是之前“点击谷歌登录页面崩溃”的根因）。
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setError('当前页面非安全上下文，Google 登录不可用。请通过 https:// 或 http://localhost:3000 打开本页后重试。');
      return;
    }
    setOauthLoading(true);
    try {
      const { error: oauthError } = await getBrowserSupabase().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: callbackUrl() },
      });
      // signInWithOAuth 可能抛错（如配置/网络异常），也可能返回 error 字段，两路统一处理
      if (oauthError) throw oauthError;
      // 成功时浏览器整页跳转至 Google 授权页，下方代码通常不再执行（spinner 保持至跳转）
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google 登录失败，请重试');
      setOauthLoading(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-soft">
          <Sparkles className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold">登录 NeoCanvas</h1>
        <p className="mt-2 text-sm text-muted-foreground">让设计更简单</p>
      </div>

      {sent ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <Mail className="mx-auto mb-3 size-8 text-accent" />
          <p className="text-sm">
            已向 <span className="font-medium">{email}</span> 发送登录链接，请查收邮件并点击完成登录。
          </p>
        </div>
      ) : (
        <form onSubmit={onMagicLink} className="flex flex-col gap-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="h-11 rounded-xl border border-border bg-background px-4 text-sm outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
          />
          <Button type="submit" size="lg" loading={sending} disabled={oauthLoading}>
            发送登录链接
          </Button>

          <div className="my-2 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            或
            <div className="h-px flex-1 bg-border" />
          </div>

          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={onOAuth}
            loading={oauthLoading}
            disabled={sending}
          >
            使用 Google 登录
          </Button>
        </form>
      )}

      {error ? <p className="mt-4 text-center text-sm text-danger">{error}</p> : null}
    </div>
  );
}
