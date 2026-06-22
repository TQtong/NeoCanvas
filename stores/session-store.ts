'use client';

/**
 * 会话 / 用户状态库（第 04 篇第三节）。
 *
 * 持有登录用户档案与语言偏好等全局信息，供信息簇（头像菜单）与各处消费。
 *
 * @module stores/session-store
 */

import { create } from 'zustand';
import type { ProfileRow } from '@/types';

/** 支持的界面语言。 */
export type Locale = 'zh-CN' | 'en';

/** 会话状态库的状态与动作。 */
export interface SessionState {
  /** 当前用户档案；未登录为 null。 */
  profile: ProfileRow | null;
  /** 当前界面语言。 */
  locale: Locale;
  /** 设置用户档案（登录 / 档案更新后）。 */
  setProfile: (profile: ProfileRow | null) => void;
  /** 设置界面语言。 */
  setLocale: (locale: Locale) => void;
}

/** 归一 locale 字符串到受支持取值。 */
export function normalizeLocale(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'zh-CN';
}

export const useSessionStore = create<SessionState>((set) => ({
  profile: null,
  locale: 'zh-CN',
  setProfile: (profile) =>
    set({ profile, locale: profile ? normalizeLocale(profile.locale) : 'zh-CN' }),
  setLocale: (locale) => set({ locale }),
}));
