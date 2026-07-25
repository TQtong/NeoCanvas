/**
 * 根布局：全局外壳、字体、主题与 Provider（第 04 篇第一节）。
 *
 * @module app/layout
 */

import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import type { ProfileRow } from '@/types';
import { createServerSupabase } from '@/lib/supabase/server';
import { Providers } from '@/components/providers';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

/**
 * 正文字体：自托管 Inter 可变字体（latin 子集）。
 *
 * 不用 `next/font/google`，以免编译期向 Google Fonts 发起出站请求——在受限网络下该
 * 请求会在 jest-worker 子进程中超时崩溃，触发「Jest worker exceeded retry limit」并
 * 使整页编译失败（页面看似渲染但事件未水合，按钮点不动）。字体文件随仓库提供，零网络依赖。
 * Inter 仅含拉丁字形，中文走系统字体回退（见 tailwind.config.ts 的 fontFamily.sans）。
 */
const inter = localFont({
  src: './fonts/inter-latin-variable.woff2',
  variable: '--font-sans',
  display: 'swap',
  weight: '100 900',
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
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${inter.variable} font-sans`}>
        <Providers initialProfile={profile}>{children}</Providers>
      </body>
    </html>
  );
}
