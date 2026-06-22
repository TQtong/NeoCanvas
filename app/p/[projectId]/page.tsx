/**
 * 设计页（第 04 篇第二节）。
 *
 * 服务端预取项目元信息、画布节点与边、主会话与历史消息及模型目录，作为快照传给客户端
 * 工作台水合。RLS 确保只能加载归属本人的项目。
 *
 * @module app/p/[projectId]/page
 */

import { notFound, redirect } from 'next/navigation';
import { createServerSupabase } from '@/lib/supabase/server';
import { loadProjectBundle, touchProjectOpened } from '@/lib/data/load-project';
import { fetchModelCatalog } from '@/lib/models/catalog';
import { DesignWorkbench } from './DesignWorkbench';

/** 设计页不缓存。 */
export const dynamic = 'force-dynamic';

/**
 * 设计页组件。
 *
 * @param props - 路由参数（projectId）
 */
export default async function DesignPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?redirect=/p/${projectId}`);
  }

  const [bundle, models] = await Promise.all([
    loadProjectBundle(supabase, projectId),
    fetchModelCatalog(supabase),
  ]);

  if (!bundle) {
    notFound();
  }

  // 标记最近打开时间（不阻塞渲染的非关键写入）
  void touchProjectOpened(supabase, projectId);

  return <DesignWorkbench bundle={bundle} models={models} />;
}
