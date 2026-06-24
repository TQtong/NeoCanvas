/**
 * 主页（第 01 篇第三节、第 04 篇第七节）。
 *
 * 服务端外壳：在请求时携带用户会话查询用户档案、最近项目与模型目录，直出标语区与最近
 * 项目网格的初始内容；创作输入框、选择条、卡片操作以客户端组件嵌入。
 *
 * @module app/page
 */

import { redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { loadHomeData } from '@/lib/data/load-home';
import { CreatePromptBox } from '@/components/home/CreatePromptBox';
import { HomeHero } from '@/components/home/HomeHero';
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
        {/* 标语层（客户端，随语言切换实时更新） */}
        <HomeHero />

        {/* 创作输入层 */}
        <div className="w-full">
          <CreatePromptBox models={models} defaultModelKey={null} />
        </div>
      </div>

      {/* 最近项目层（标题在网格内随语言切换） */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <RecentProjectsGrid initialProjects={projects} />
      </section>
    </main>
  );
}
