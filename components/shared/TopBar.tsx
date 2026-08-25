'use client';

/**
 * 设计页顶栏（第 01 篇、第 04 篇 4.x）。
 *
 * 绝对定位于画布之上的半透明条：左端为返回首页 + Logo + 项目名（双击就地重命名）+ 版本切换占位，
 * 右端为分享、面板展开 / 收起与头像菜单。重命名提交时把新标题写回 `projects.title`，
 * 分享则复制当前页地址到剪贴板，两者均以轻量提示条反馈。
 *
 * @module components/shared/TopBar
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CloudOff,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Share2,
  TriangleAlert,
} from 'lucide-react';
import type { RealtimeStatus, SyncState } from '@/types';
import { useTranslation } from '@/i18n';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils/cn';
import { AvatarMenu } from '@/components/shared/AvatarMenu';

/** 顶栏属性。 */
export interface TopBarProps {
  /** 当前项目 ID，用于重命名写回。 */
  projectId: string;
  /** 项目标题（受控初值；本地编辑态在提交后由上层数据流回灌）。 */
  title: string;
  /** 对话面板是否展开。 */
  chatOpen: boolean;
  /** Realtime 连接状态。 */
  realtimeStatus: RealtimeStatus;
  /** 本地持久化状态。 */
  syncState: SyncState;
  /** 切换对话面板展开状态。 */
  onToggleChat: () => void;
  /** 重命名成功后的受控标题回写。 */
  onTitleChange: (title: string) => void;
  /** 保存失败后的手动重试。 */
  onRetrySync: () => void;
}

/**
 * 设计页顶栏组件。
 *
 * @param props - 见 {@link TopBarProps}
 * @returns 顶栏条
 */
export function TopBar({
  projectId,
  title,
  chatOpen,
  realtimeStatus,
  syncState,
  onToggleChat,
  onTitleChange,
  onRetrySync,
}: TopBarProps) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();

  // 就地重命名的本地编辑态：editing 控制是否展示输入框，value 为草稿值
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameInFlightRef = useRef(false);

  // 外部 title 变化（如刷新或他端更新）时，若未处于编辑中则同步草稿值
  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);

  // 进入编辑态后聚焦并全选，便于直接覆写
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = useCallback(() => {
    setValue(title);
    setEditing(true);
  }, [title]);

  // 提交重命名：去空白校验，无变化则静默收起；有变化则写回 projects.title
  const commit = useCallback(async () => {
    if (renameInFlightRef.current) return;
    const next = value.trim();
    setEditing(false);
    if (!next || next === title) {
      setValue(title);
      return;
    }
    renameInFlightRef.current = true;
    try {
      const { error } = await getBrowserSupabase()
        .from('projects')
        .update({ title: next })
        .eq('id', projectId);
      if (error) {
        // 写回失败：回滚草稿并提示
        setValue(title);
        toastError(error.message);
        return;
      }
      setValue(next);
      onTitleChange(next);
      success(t('design.renameProject'));
    } finally {
      renameInFlightRef.current = false;
    }
  }, [value, title, projectId, success, toastError, t, onTitleChange]);

  // 取消编辑：丢弃草稿、收起输入框
  const cancelEdit = useCallback(() => {
    setValue(title);
    setEditing(false);
  }, [title]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void commit();
    },
    [commit],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Enter 提交、Esc 取消；其余按键交由输入框默认处理
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      }
    },
    [cancelEdit],
  );

  // 分享：复制当前页地址到剪贴板并提示
  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      success(t('common.linkCopied'));
    } catch {
      toastError(t('common.share'));
    }
  }, [success, toastError, t]);

  return (
    <header className="glass absolute inset-x-0 top-0 z-40 flex h-14 items-center justify-between px-4">
      {/* 左端：返回首页 + Logo + 项目名 + 版本切换占位 */}
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip content={t('design.backHome')}>
          <Link
            href="/"
            aria-label={t('design.backHome')}
            title={t('design.backHome')}
            className={cn(
              'inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150',
              'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              '[&_svg]:size-[18px]',
            )}
          >
            <ArrowLeft />
          </Link>
        </Tooltip>

        <span aria-hidden className="size-6 shrink-0 rounded-full bg-accent shadow-soft" />

        {editing ? (
          <form onSubmit={handleSubmit} className="min-w-0">
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onBlur={() => void commit()}
              onKeyDown={handleKeyDown}
              aria-label={t('design.renameProject')}
              className={cn(
                'h-8 w-48 max-w-[40vw] rounded-lg border border-border bg-card px-2 text-sm font-medium text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            />
          </form>
        ) : (
          <button
            type="button"
            onDoubleClick={beginEdit}
            title={t('design.renameProject')}
            className={cn(
              'truncate rounded-lg px-2 py-1 text-sm font-medium text-foreground transition-colors',
              'hover:bg-muted',
            )}
          >
            {title}
          </button>
        )}

        {/* 版本 / 标签切换：下拉列出同项目的版本 / 标签并切换。当前数据模型仅单一版本，
            故菜单展示当前版本并标明暂无其他版本（待引入版本快照后自然填充）。 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('design.versionSwitcher')}
              title={t('design.versionSwitcher')}
              className={cn(
                'inline-flex shrink-0 items-center gap-0.5 rounded-lg px-1 py-1 text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <ChevronDown className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            <DropdownMenuLabel className="text-sm font-medium text-foreground">
              {t('design.versionSwitcher')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>{t('design.noVersions')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 右端：分享、面板控制、头像菜单 */}
      <div className="flex items-center gap-1">
        <Tooltip
          content={
            syncState.status === 'error'
              ? `${t('sync.error')}：${syncState.message}`
              : t(`sync.${syncState.status}`)
          }
        >
          <button
            type="button"
            disabled={syncState.status === 'saved' || syncState.status === 'saving'}
            onClick={onRetrySync}
            className={cn(
              'mr-1 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent',
              syncState.status === 'error' && 'text-destructive',
            )}
            aria-label={
              syncState.status === 'error'
                ? `${t('sync.error')}：${syncState.message}`
                : t(`sync.${syncState.status}`)
            }
          >
            {syncState.status === 'saved' ? (
              <Check className="size-4 text-emerald-500" />
            ) : syncState.status === 'saving' ? (
              <LoaderCircle className="size-4 animate-spin text-amber-500" />
            ) : syncState.status === 'offline' ? (
              <CloudOff className="size-4" />
            ) : (
              <TriangleAlert className="size-4" />
            )}
            <span className="hidden lg:inline">{t(`sync.${syncState.status}`)}</span>
            {'pendingCount' in syncState && syncState.pendingCount > 0 ? (
              <span aria-hidden>({syncState.pendingCount})</span>
            ) : null}
          </button>
        </Tooltip>

        <Tooltip content={t(`sync.realtime.${realtimeStatus}`)}>
          <span
            className={cn(
              'mr-1 size-2 rounded-full',
              realtimeStatus === 'connected'
                ? 'bg-emerald-500'
                : realtimeStatus === 'error'
                  ? 'bg-destructive'
                  : realtimeStatus === 'disconnected'
                    ? 'bg-muted-foreground'
                    : 'animate-pulse bg-amber-500',
            )}
            role="status"
            aria-label={t(`sync.realtime.${realtimeStatus}`)}
          />
        </Tooltip>

        <Tooltip content={t('common.share')}>
          <IconButton label={t('common.share')} onClick={() => void handleShare()}>
            <Share2 />
          </IconButton>
        </Tooltip>

        <Tooltip content={t(chatOpen ? 'design.collapsePanel' : 'design.expandPanel')}>
          <IconButton
            label={t(chatOpen ? 'design.collapsePanel' : 'design.expandPanel')}
            aria-expanded={chatOpen}
            aria-controls="project-chat-panel"
            onClick={onToggleChat}
          >
            {chatOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </IconButton>
        </Tooltip>

        <AvatarMenu />
      </div>
    </header>
  );
}
