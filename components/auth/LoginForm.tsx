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
}

/**
 * 登录表单组件。
 */
export function LoginForm({ redirectTo }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const { error: oauthError } = await getBrowserSupabase().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl() },
    });
    if (oauthError) setError(oauthError.message);
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
          <Button type="submit" size="lg" loading={sending}>
            发送登录链接
          </Button>

          <div className="my-2 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            或
            <div className="h-px flex-1 bg-border" />
          </div>

          <Button type="button" variant="outline" size="lg" onClick={onOAuth}>
            使用 Google 登录
          </Button>
        </form>
      )}

      {error ? <p className="mt-4 text-center text-sm text-danger">{error}</p> : null}
    </div>
  );
}
