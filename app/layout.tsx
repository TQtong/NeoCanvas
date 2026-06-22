/**
 * 根布局：全局外壳、字体、主题与 Provider（第 04 篇第一节）。
 *
 * @module app/layout
 */

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import type { ProfileRow } from '@/types';
import { createServerSupabase } from '@/lib/supabase/server';
import { Providers } from '@/components/providers';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NeoCanvas — 让设计更简单',
  description: '对话驱动 + 无限画布的 AI 设计代理，懂你的设计代理，帮你搞定一切。',
  applicationName: 'NeoCanvas',
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

/**
 * 根布局组件。在服务端取用户档案以水合会话库。
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile: ProfileRow | null = null;
  if (user) {
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    profile = (data as ProfileRow | null) ?? null;
  }

  return (
    <html lang={profile?.locale === 'en' ? 'en' : 'zh-CN'} suppressHydrationWarning>
      <body className={`${inter.variable} font-sans`}>
        <Providers initialProfile={profile}>{children}</Providers>
      </body>
    </html>
  );
}
