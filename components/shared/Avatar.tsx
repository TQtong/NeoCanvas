'use client';

/**
 * 统一头像渲染组件（头像菜单 / 设置共用）。
 *
 * 按以下优先级决定呈现，集中处理「加载失败」与「无头像」的兜底：
 *  1. `avatar_url` 是 `preset:<key>` → 渲染对应内联卡通 SVG（零网络依赖，必显）。
 *  2. `avatar_url` 是普通 http(s) URL → `<img>` 呈现；加载失败（如被墙的谷歌 CDN）
 *     转入第 3 步兜底，而非显示裂图。
 *  3. 提供了 `seed`（一般为 user id）→ 按其稳定挑一个默认卡通形象。
 *  4. 否则回退为展示名首字母。
 *
 * @module components/shared/Avatar
 */

import { useEffect, useState } from 'react';
import {
  defaultPresetForSeed,
  getAvatarPreset,
  presetKeyFromUrl,
} from '@/lib/avatars';
import { cn } from '@/lib/utils/cn';

/** {@link Avatar} 属性。 */
export interface AvatarProps {
  /** 头像地址：`preset:<key>`、http(s) URL 或空。 */
  url?: string | null;
  /** 展示名，用于无图兜底的首字母与图片 alt。 */
  name?: string | null;
  /** 默认卡通形象的种子（一般为 user id）；缺省则无图时回退首字母。 */
  seed?: string | null;
  /** 透传到叶子元素的类名。 */
  className?: string;
}

/** 由展示名推导首字母（大写）；无名时回退 'U'。 */
function avatarInitial(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (trimmed && trimmed.length > 0) return trimmed[0]!.toUpperCase();
  return 'U';
}

/**
 * 头像组件：渲染填满父容器的叶子元素，父容器负责圆形裁切与尺寸。
 */
export function Avatar({ url, name, seed, className }: AvatarProps) {
  // 图片加载失败标记；url 变化时复位，给新地址一次重新加载机会
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  const presetKey = presetKeyFromUrl(url);

  // 1. 预设卡通
  if (presetKey) {
    const preset = getAvatarPreset(presetKey) ?? (seed ? defaultPresetForSeed(seed) : undefined);
    if (preset) return <preset.Component className={cn('size-full', className)} />;
  }

  // 2. 普通图片 URL（未失败时）
  if (url && !presetKey && !broken) {
    return (
      <img
        src={url}
        alt={name ?? ''}
        className={cn('size-full object-cover', className)}
        onError={() => setBroken(true)}
      />
    );
  }

  // 3. 默认卡通（有种子时）
  if (seed) {
    const preset = defaultPresetForSeed(seed);
    return <preset.Component className={cn('size-full', className)} />;
  }

  // 4. 首字母兜底
  return <span aria-hidden>{avatarInitial(name)}</span>;
}
