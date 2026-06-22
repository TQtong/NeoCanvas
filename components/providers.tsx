'use client';

/**
 * 全局客户端 Provider 与会话水合。
 *
 * 在根布局包裹一次：以服务端取得的用户档案初始化会话状态库（驱动语言与头像），提供
 * Tooltip 上下文，并挂载全局提示条容器。
 *
 * @module components/providers
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { ProfileRow } from '@/types';
import { useSessionStore } from '@/stores/session-store';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toast';

/** Provider 属性。 */
export interface ProvidersProps {
  /** 服务端取得的用户档案（未登录为 null）。 */
  initialProfile: ProfileRow | null;
  /** 子节点。 */
  children: ReactNode;
}

/**
 * 全局 Provider。
 */
export function Providers({ initialProfile, children }: ProvidersProps) {
  const setProfile = useSessionStore((s) => s.setProfile);
  const hydrated = useRef(false);

  // 首次以服务端档案初始化会话库（仅一次，避免覆盖客户端后续变更）
  if (!hydrated.current) {
    hydrated.current = true;
    setProfile(initialProfile);
  }

  // 档案在服务端刷新（如跨页导航）时同步
  useEffect(() => {
    setProfile(initialProfile);
  }, [initialProfile, setProfile]);

  return (
    <TooltipProvider delayDuration={200}>
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
