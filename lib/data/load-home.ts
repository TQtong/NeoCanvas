import 'server-only';

/**
 * 主页初始数据加载（第 04 篇第二节）。
 *
 * 服务端组件在请求时携带用户会话查询用户档案、最近项目与模型目录，直接渲染首屏。
 *
 * @module lib/data/load-home
 */

import type { ModelCatalogEntry, ProfileRow, ProjectSummary } from '@/types';
import type { TypedSupabaseClient } from '@/lib/supabase/types';
import { fetchModelCatalog } from '@/lib/models/catalog';
import { PROJECTS_PAGE_SIZE, projectRowToSummary } from './mappers';

/** 主页初始数据包。 */
export interface HomeData {
  /** 当前用户档案；未登录为 null。 */
  profile: ProfileRow | null;
  /** 最近项目首屏。 */
  projects: ProjectSummary[];
  /** 模型目录。 */
  models: ModelCatalogEntry[];
}

/**
 * 加载主页初始数据。
 *
 * @param supabase - 服务端 Supabase 客户端
 * @returns 主页数据包
 */
export async function loadHomeData(supabase: TypedSupabaseClient): Promise<HomeData> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { profile: null, projects: [], models: [] };
  }

  const [profileResult, projectsResult, models] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabase
      .from('projects')
      .select('*')
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PROJECTS_PAGE_SIZE),
    fetchModelCatalog(supabase),
  ]);

  return {
    profile: (profileResult.data as ProfileRow | null) ?? null,
    projects: (projectsResult.data ?? []).map(projectRowToSummary),
    models,
  };
}
