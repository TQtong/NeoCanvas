'use client';

/**
 * 头像菜单：右上角信息簇的用户入口（第 04 篇信息簇 / shared）。
 *
 * 读取会话状态库中的用户档案，渲染圆形头像按钮；点击展开下拉菜单，包含设置入口、
 * 语言切换（中文 / English）、退出登录。语言切换在切换本地状态的同时把偏好写回
 * `profiles.locale`，使下次登录沿用；退出登录调用 Supabase Auth 后跳转登录页。
 *
 * @module components/shared/AvatarMenu
 */

import { useCallback, useState } from 'react';
import { Check, LogOut, Moon, Settings, Sun } from 'lucide-react';
import { useSessionStore, type Locale } from '@/stores/session-store';
import { useTranslation } from '@/i18n';
import { getBrowserSupabase } from '@/lib/supabase/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils/cn';
import { Avatar } from './Avatar';
import { SettingsDialog } from './SettingsDialog';

/** 受支持语言及其在菜单中的展示名（保留各自原生写法）。 */
const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

/**
 * 头像菜单组件。无可见参数，状态全部取自会话状态库。
 *
 * @returns 头像按钮与其下拉菜单
 */
export function AvatarMenu() {
  const profile = useSessionStore((s) => s.profile);
  const locale = useSessionStore((s) => s.locale);
  const setLocale = useSessionStore((s) => s.setLocale);
  const resolvedTheme = useSessionStore((s) => s.resolvedTheme);
  const setTheme = useSessionStore((s) => s.setTheme);
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 切换语言：先更新本地状态以即时反映，再把偏好持久化到 profiles.locale
  const handleSetLocale = useCallback(
    (next: Locale) => {
      if (next === locale) return;
      setLocale(next);
      const id = profile?.id;
      if (!id) return;
      // 写回失败不阻断界面（仅影响下次登录的默认语言），故忽略其 Promise 结果
      void getBrowserSupabase().from('profiles').update({ locale: next }).eq('id', id);
    },
    [locale, setLocale, profile?.id],
  );

  // 退出登录：注销会话后硬跳转登录页，确保清空内存态
  const handleLogout = useCallback(async () => {
    await getBrowserSupabase().auth.signOut();
    window.location.href = '/login';
  }, []);

  const displayName = profile?.display_name?.trim() || 'NeoCanvas';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={displayName}
            className={cn(
              'inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full',
              'border border-border bg-accent-muted text-sm font-semibold text-accent',
              'transition-shadow duration-150 hover:shadow-soft',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            )}
          >
            {/* 统一头像渲染：预设卡通 / 上传图 / 默认卡通(按 user id) / 首字母兜底 */}
            <Avatar
              url={profile?.avatar_url ?? null}
              name={profile?.display_name}
              seed={profile?.id ?? null}
            />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="min-w-[12rem]">
          {/* 顶部展示当前用户名，作为菜单上下文 */}
          <DropdownMenuLabel className="truncate text-sm font-medium text-foreground">
            {displayName}
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <Settings />
            {t('common.settings')}
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
            {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
            {resolvedTheme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {LOCALE_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.value}
              // 防止 Radix 在选中后关闭菜单前的默认行为之外，仍需阻止冒泡触发以外的副作用
              onSelect={() => handleSetLocale(option.value)}
            >
              <Check className={cn('opacity-0', option.value === locale && 'opacity-100')} />
              {option.label}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          <DropdownMenuItem destructive onSelect={() => void handleLogout()}>
            <LogOut />
            {t('common.logout')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}
