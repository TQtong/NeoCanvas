'use client';

/**
 * 主页标语层（第 01 篇第三节、第 04 篇第十节）。
 *
 * 标语与副标题经 i18n 呈现，随 AvatarMenu 的语言切换实时更新（服务端组件无法订阅客户端
 * 语言状态，故抽为客户端组件）。品牌名「NeoCanvas」作为产品标语的一部分由文案键统一承载。
 *
 * @module components/home/HomeHero
 */

import { Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n';

/**
 * 主页标语层组件。
 */
export function HomeHero() {
  const { t } = useTranslation();
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-soft">
        <Sparkles className="size-7" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('home.tagline')}</h1>
      <p className="mt-3 text-sm text-muted-foreground sm:text-base">{t('home.subtitle')}</p>
    </div>
  );
}
