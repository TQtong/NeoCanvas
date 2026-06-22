'use client';

/**
 * 主页模型 / 场景选择条（第 01 篇、第 05 篇第七节）。
 *
 * 由两组胶囊按钮构成：第一组为模型目录（单选所选模型），第二组为创作场景。场景分两段
 * 展示——`INLINE_SCENES`（Design / Branding / E-Commerce）排在第一行，`STANDALONE_SCENES`
 * （Video）单独居中成行；场景为单选，再次点击当前选中项即取消。
 *
 * @module components/home/ModelSceneSelector
 */

import type { ModelCatalogEntry, Scene } from '@/types';
import { SCENE_DEFINITIONS, INLINE_SCENES, STANDALONE_SCENES } from '@/lib/scenes';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';

/** {@link ModelSceneSelector} 属性。 */
export interface ModelSceneSelectorProps {
  /** 可选模型目录。 */
  models: ModelCatalogEntry[];
  /** 当前所选模型键。 */
  modelKey: string;
  /** 当前所选场景（可空）。 */
  scene: Scene | null;
  /** 切换模型回调。 */
  onModelChange: (key: string) => void;
  /** 切换场景回调（传入 null 表示取消选择）。 */
  onSceneChange: (scene: Scene | null) => void;
}

/** 胶囊按钮基础类：圆角全圆、固定高度与左右内距。 */
const PILL_BASE =
  'inline-flex h-9 select-none items-center justify-center rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * 模型 / 场景选择条组件。
 *
 * @param props - 见 {@link ModelSceneSelectorProps}
 * @returns 选择条节点
 */
export function ModelSceneSelector({
  models,
  modelKey,
  scene,
  onModelChange,
  onSceneChange,
}: ModelSceneSelectorProps) {
  const { t } = useTranslation();

  /** 点选场景：再次点击当前选中项即取消，否则切换为该场景。 */
  const handleSceneClick = (next: Scene) => {
    onSceneChange(scene === next ? null : next);
  };

  return (
    <div className="flex flex-col items-center gap-2.5">
      {/* 第一组：模型目录（单选，所选高亮 accent） */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {models.map((model) => {
          const selected = model.key === modelKey;
          return (
            <button
              key={model.key}
              type="button"
              aria-pressed={selected}
              onClick={() => onModelChange(model.key)}
              className={cn(
                PILL_BASE,
                selected
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {/* 模型展示名保留英文原文以贴合草图 */}
              {model.displayName}
            </button>
          );
        })}
      </div>

      {/* 第二组第一行：行内场景（Design / Branding / E-Commerce） */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {INLINE_SCENES.map((item) => {
          const selected = scene === item;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={selected}
              onClick={() => handleSceneClick(item)}
              className={cn(
                PILL_BASE,
                selected
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {t(SCENE_DEFINITIONS[item].labelKey)}
            </button>
          );
        })}
      </div>

      {/* 第二组第二行：单独成行的场景（Video），居中展示 */}
      <div className="flex items-center justify-center gap-2">
        {STANDALONE_SCENES.map((item) => {
          const selected = scene === item;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={selected}
              onClick={() => handleSceneClick(item)}
              className={cn(
                PILL_BASE,
                selected
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {t(SCENE_DEFINITIONS[item].labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
