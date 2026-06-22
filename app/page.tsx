/**
 * 主页（第 01 篇第三节、第 04 篇第七节）。
 *
 * 服务端外壳：在请求时携带用户会话查询用户档案、最近项目与模型目录，直出标语区与最近
 * 项目网格的初始内容；创作输入框、选择条、卡片操作以客户端组件嵌入。
 *
 * @module app/page
 */

import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { createServerSupabase } from '@/lib/supabase/server';
import { loadHomeData } from '@/lib/data/load-home';
import { CreatePromptBox } from '@/components/home/CreatePromptBox';
import { RecentProjectsGrid } from '@/components/home/RecentProjectsGrid';
import { AvatarMenu } from '@/components/shared/AvatarMenu';

/** 主页不缓存，始终反映最新项目列表。 */
export const dynamic = 'force-dynamic';

/**
 * 主页组件。
 */
export default async function HomePage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const { projects, models } = await loadHomeData(supabase);

  return (
    <main className="relative min-h-screen w-full">
      {/* 右上信息簇 */}
      <div className="absolute right-5 top-5 z-20">
        <AvatarMenu />
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pb-24 pt-20 sm:pt-28">
        {/* 标语层 */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-soft">
            <Sparkles className="size-7" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            NeoCanvas <span className="text-muted-foreground">让设计更简单</span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground sm:text-base">
            懂你的设计代理，帮你搞定一切
          </p>
        </div>

        {/* 创作输入层 */}
        <div className="w-full">
          <CreatePromptBox models={models} defaultModelKey={null} />
        </div>
      </div>

      {/* 最近项目层 */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <h2 className="mb-5 text-lg font-medium">最近项目</h2>
        <RecentProjectsGrid initialProjects={projects} />
      </section>
    </main>
  );
}
