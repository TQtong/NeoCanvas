'use client';

/**
 * 最近项目网格（第 04 篇 4.7、第七节）。
 *
 * 以 {@link useProjects} 承载分页加载与重命名 / 软删的乐观更新。网格首位固定为
 * {@link NewProjectCard} 新建入口，其后依序渲染 {@link ProjectCard}。仍有更多时展示
 * 「加载更多」；加载中以骨架卡片占位；无任何项目时展示空态文案。
 *
 * @module components/home/RecentProjectsGrid
 */

import type { ProjectSummary } from '@/types';
import { useProjects } from '@/lib/hooks/use-projects';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { ProjectCard, NewProjectCard } from './ProjectCard';

/** {@link RecentProjectsGrid} 属性。 */
export interface RecentProjectsGridProps {
  /** 服务端预取的首屏项目（水合）。 */
  initialProjects: ProjectSummary[];
}

/** 加载态骨架卡片数量。 */
const SKELETON_COUNT = 4;

/**
 * 最近项目网格组件。
 *
 * @param props - 见 {@link RecentProjectsGridProps}
 * @returns 项目网格节点
 */
export function RecentProjectsGrid({ initialProjects }: RecentProjectsGridProps) {
  const { t } = useTranslation();
  const { toast, error: toastError } = useToast();
  const { projects, loading, hasMore, loadMore, rename, softDelete, restore } =
    useProjects(initialProjects);

  // 重命名：交由 hook 做乐观更新，失败时回退并提示
  const handleRename = (id: string, title: string) => {
    void rename(id, title).catch((err) => {
      toastError(err instanceof Error ? err.message : t('error.internal_error'));
    });
  };

  // 软删除：删除后弹出可「撤销」的提示，保留期内一键恢复
  const handleDelete = (id: string) => {
    const project = projects.find((p) => p.id === id);
    void softDelete(id)
      .then(() => {
        if (!project) return;
        toast(t('home.projectDeleted'), {
          variant: 'info',
          duration: 6000,
          action: {
            label: t('common.undo'),
            onClick: () => {
              void restore(project).catch((err) => {
                toastError(err instanceof Error ? err.message : t('error.internal_error'));
              });
            },
          },
        });
      })
      .catch((err) => {
        toastError(err instanceof Error ? err.message : t('error.internal_error'));
      });
  };

  // 空态：无任何项目且非加载中时，仅保留新建卡片并给出引导
  const isEmpty = projects.length === 0 && !loading;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">{t('home.recentProjects')}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {/* 首位固定为新建入口 */}
        <NewProjectCard />

        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        ))}

        {/* 加载下一页时以骨架卡片占位 */}
        {loading
          ? Array.from({ length: SKELETON_COUNT }).map((_, index) => (
              <div key={`skeleton-${index}`} className="flex flex-col gap-2">
                <Skeleton className="aspect-video w-full rounded-2xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))
          : null}
      </div>

      {/* 空态引导文案 */}
      {isEmpty ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('home.emptyProjects')}</p>
      ) : null}

      {/* 加载更多 */}
      {hasMore ? (
        <div className="flex justify-center pt-2">
          <Button variant="outline" loading={loading} onClick={() => void loadMore()}>
            {t('home.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
