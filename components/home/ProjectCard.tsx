'use client';

/**
 * 最近项目卡片与新建项目卡片（第 04 篇 4.7、第 05 篇第七节）。
 *
 * {@link ProjectCard} 为单个项目的入口卡片：上半为缩略图，下半为标题与更新时间；悬停时
 * 右上角浮出更多菜单，提供重命名 / 删除（均以对话框二次确认后回调）。{@link NewProjectCard}
 * 为虚线占位卡片，提交到服务端动作 `createBlankProjectAction` 以创建空白项目。
 *
 * @module components/home/ProjectCard
 */

import { useState } from 'react';
import Link from 'next/link';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { createBlankProjectAction } from '@/app/actions';
import type { ProjectSummary } from '@/types';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { formatUpdatedDate } from '@/lib/utils/format';
import { useTranslation } from '@/i18n';

/** {@link ProjectCard} 属性。 */
export interface ProjectCardProps {
  /** 项目摘要。 */
  project: ProjectSummary;
  /** 重命名回调（确认后调用）。 */
  onRename: (id: string, title: string) => void;
  /** 删除回调（确认后调用）。 */
  onDelete: (id: string) => void;
}

/**
 * 单个项目卡片。
 *
 * @param props - 见 {@link ProjectCardProps}
 * @returns 项目卡片节点
 */
export function ProjectCard({ project, onRename, onDelete }: ProjectCardProps) {
  const { t, locale } = useTranslation();

  // 重命名 / 删除对话框开关与重命名草稿
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(project.title);

  /** 打开重命名对话框前，以当前标题初始化草稿。 */
  const openRename = () => {
    setDraftTitle(project.title);
    setRenameOpen(true);
  };

  /** 确认重命名：去空白后非空且有变化时回调。 */
  const confirmRename = () => {
    const next = draftTitle.trim();
    if (next.length > 0 && next !== project.title) {
      onRename(project.id, next);
    }
    setRenameOpen(false);
  };

  /** 确认删除：回调后关闭对话框。 */
  const confirmDelete = () => {
    onDelete(project.id);
    setDeleteOpen(false);
  };

  const displayTitle = project.title.trim() || t('common.untitled');

  return (
    <>
      <div className="group relative">
        <Link
          href={`/p/${project.id}`}
          className="block overflow-hidden rounded-2xl border border-border bg-card shadow-soft transition-shadow duration-150 hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* 上半：缩略图（有签名 URL 则展示图片，否则占位底色） */}
          <div className="aspect-video w-full overflow-hidden bg-muted">
            {project.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- 缩略图为运行时签名 URL，跳过 next/image 优化
              <img
                src={project.thumbnailUrl}
                alt={displayTitle}
                className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                loading="lazy"
              />
            ) : null}
          </div>

          {/* 下半：标题与更新时间 */}
          <div className="flex flex-col gap-0.5 px-3.5 py-3">
            <span className="truncate text-sm font-medium text-foreground">{displayTitle}</span>
            <span className="text-xs text-muted-foreground">
              {t('home.updatedAt', { date: formatUpdatedDate(project.updatedAt, locale) })}
            </span>
          </div>
        </Link>

        {/* 悬停浮出的更多菜单（绝对定位于右上角） */}
        <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                label={t('common.settings')}
                className="glass text-foreground shadow-soft"
              >
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={openRename}>
                <Pencil />
                {t('common.rename')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 重命名对话框 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogTitle className="text-base font-semibold text-foreground">
            {t('design.renameProject')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('common.rename')}</DialogDescription>
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmRename();
              }
            }}
            autoFocus
            className="mt-4 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmRename} disabled={draftTitle.trim().length === 0}>
              {t('common.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认对话框 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogTitle className="text-base font-semibold text-foreground">
            {t('common.delete')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            {t('home.deleteProjectConfirm')}
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              {t('common.delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 新建项目卡片：虚线占位卡片，提交到服务端动作创建空白项目。
 *
 * @returns 新建项目卡片节点
 */
export function NewProjectCard() {
  const { t } = useTranslation();

  return (
    <form action={createBlankProjectAction} className="contents">
      <button
        type="submit"
        className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-card/40 text-muted-foreground transition-colors duration-150 hover:border-accent hover:bg-accent-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-foreground transition-colors group-hover:bg-accent-muted">
          <Plus className="size-6" />
        </span>
        <span className="text-sm font-medium">{t('home.newProject')}</span>
      </button>
    </form>
  );
}
