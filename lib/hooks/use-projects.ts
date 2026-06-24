'use client';

/**
 * 项目领域钩子：最近项目分页加载、新建、重命名、软删与恢复（第 04 篇第七节）。
 *
 * 列表查询命中第 03 篇为「最近项目」设计的复合索引（owner_id, is_deleted,
 * updated_at desc），并以按时间游标（keyset）分页，在大数据量下保持稳定。
 *
 * @module lib/hooks/use-projects
 */

import { useCallback, useState } from 'react';
import type { ProjectSummary } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { fromSupabaseError } from '@/lib/edge/errors';
import { signStorageRef, THUMBNAIL_WIDTH } from '@/lib/storage/signed-url';
import { PROJECTS_PAGE_SIZE, projectRowToSummary } from '@/lib/data/mappers';

export { PROJECTS_PAGE_SIZE };

/** 按时间游标。 */
export interface ProjectCursor {
  updatedAt: string;
  id: string;
}

/** useProjects 返回值。 */
export interface UseProjects {
  /** 已加载的项目摘要。 */
  projects: ProjectSummary[];
  /** 是否正在加载下一页。 */
  loading: boolean;
  /** 是否还有更多。 */
  hasMore: boolean;
  /** 错误信息（可读）。 */
  error: string | null;
  /** 加载下一页（增量）。 */
  loadMore: () => Promise<void>;
  /** 重置并从头加载。 */
  refresh: () => Promise<void>;
  /** 本地插入一个新项目（创建后即时反映）。 */
  prepend: (project: ProjectSummary) => void;
  /** 重命名项目。 */
  rename: (id: string, title: string) => Promise<void>;
  /** 软删除项目。 */
  softDelete: (id: string) => Promise<void>;
  /** 恢复一个被软删的项目（撤销删除）。 */
  restore: (project: ProjectSummary) => Promise<void>;
}

/**
 * 项目钩子。
 *
 * @param initialProjects - 服务端预取的首屏项目（水合）
 * @returns 项目数据与动作
 */
export function useProjects(initialProjects: ProjectSummary[] = []): UseProjects {
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(initialProjects.length >= PROJECTS_PAGE_SIZE);

  const fetchPage = useCallback(async (cursor: ProjectCursor | null): Promise<ProjectSummary[]> => {
    const supabase = getBrowserSupabase();
    let query = supabase
      .from('projects')
      .select('*')
      .eq('is_deleted', false)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PROJECTS_PAGE_SIZE);

    if (cursor) {
      // keyset：updated_at < cursor.updatedAt，或同值时 id < cursor.id
      query = query.or(
        `updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error: queryError } = await query;
    if (queryError) {
      throw fromSupabaseError(queryError);
    }
    // 缩略图引用（"bucket/path"）在客户端签名为可访问 URL
    return Promise.all(
      (data ?? []).map(async (row) => {
        const summary = projectRowToSummary(row);
        return { ...summary, thumbnailUrl: await signStorageRef(supabase, summary.thumbnailUrl, THUMBNAIL_WIDTH) };
      }),
    );
  }, []);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    try {
      const last = projects[projects.length - 1];
      const cursor = last ? { updatedAt: last.updatedAt, id: last.id } : null;
      const page = await fetchPage(cursor);
      setProjects((prev) => [...prev, ...page]);
      setHasMore(page.length >= PROJECTS_PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [fetchPage, hasMore, loading, projects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null);
      setProjects(page);
      setHasMore(page.length >= PROJECTS_PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const prepend = useCallback((project: ProjectSummary) => {
    setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    const supabase = getBrowserSupabase();
    // 乐观更新
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)));
    const { error: updateError } = await supabase.from('projects').update({ title }).eq('id', id);
    if (updateError) {
      throw fromSupabaseError(updateError);
    }
  }, []);

  const softDelete = useCallback(async (id: string) => {
    const supabase = getBrowserSupabase();
    // 乐观隐藏
    setProjects((prev) => prev.filter((p) => p.id !== id));
    const { error: updateError } = await supabase
      .from('projects')
      .update({ is_deleted: true })
      .eq('id', id);
    if (updateError) {
      throw fromSupabaseError(updateError);
    }
  }, []);

  const restore = useCallback(async (project: ProjectSummary) => {
    const supabase = getBrowserSupabase();
    // 乐观恢复：按更新时间倒序插回（与列表排序一致）
    setProjects((prev) =>
      prev.some((p) => p.id === project.id)
        ? prev
        : [project, ...prev].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
    const { error: updateError } = await supabase
      .from('projects')
      .update({ is_deleted: false })
      .eq('id', project.id);
    if (updateError) {
      throw fromSupabaseError(updateError);
    }
  }, []);

  return { projects, loading, hasMore, error, loadMore, refresh, prepend, rename, softDelete, restore };
}
