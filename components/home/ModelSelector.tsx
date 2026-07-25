'use client';

/**
 * 主页模型选择条（第 01 篇、第 05 篇第七节）。
 *
 * 以胶囊按钮切换图像 / 视频生成模态，再通过下拉菜单选择该模态下的具体模型。所选模型
 * 的模态直接决定新会话的生成类型，不再叠加独立的场景选择。
 *
 * @module components/home/ModelSelector
 */

import { Check, ChevronDown, Image, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ModelCatalogEntry, Modality } from '@/types';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** {@link ModelSelector} 属性。 */
export interface ModelSelectorProps {
  /** 可选模型目录。 */
  models: ModelCatalogEntry[];
  /** 当前所选模型键。 */
  modelKey: string;
  /** 切换模型回调。 */
  onModelChange: (key: string) => void;
}

/** 胶囊按钮基础类：圆角全圆、固定高度与左右内距。 */
const PILL_BASE =
  'inline-flex h-9 select-none items-center justify-center rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** 首页支持的媒体生成模态。 */
type HomeModality = Extract<Modality, 'image' | 'video'>;

/** 首页媒体模态及其图标，顺序与产品界面一致。 */
const MODALITY_OPTIONS: ReadonlyArray<{
  modality: HomeModality;
  labelKey: string;
  icon: LucideIcon;
}> = [
  { modality: 'image', labelKey: 'modality.image', icon: Image },
  { modality: 'video', labelKey: 'modality.video', icon: Video },
];

/**
 * 模型模态与具体模型选择条。
 *
 * @param props - 见 {@link ModelSelectorProps}
 * @returns 选择条节点
 */
export function ModelSelector({ models, modelKey, onModelChange }: ModelSelectorProps) {
  const { t } = useTranslation();

  if (models.length === 0) {
    return (
      <p className="px-2 text-center text-sm text-muted-foreground">
        {t('home.noAvailableModels')}
      </p>
    );
  }

  const selectedModel = models.find((model) => model.key === modelKey) ?? models[0];
  const selectedModality = selectedModel?.modality;
  const availableModalities = MODALITY_OPTIONS.filter(({ modality }) =>
    models.some((model) => model.modality === modality),
  );
  const modelsInSelectedModality = selectedModality
    ? models.filter((model) => model.modality === selectedModality)
    : [];

  /** 切换模态时选择该分类排序最靠前的模型，确保提交模型始终属于当前分类。 */
  const handleModalityChange = (modality: HomeModality) => {
    const firstModel = models.find((model) => model.modality === modality);
    if (firstModel) onModelChange(firstModel.key);
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {availableModalities.map(({ modality, labelKey, icon: ModalityIcon }) => {
        const selected = modality === selectedModality;
        return (
          <button
            key={modality}
            type="button"
            aria-pressed={selected}
            onClick={() => handleModalityChange(modality)}
            className={cn(
              PILL_BASE,
              'gap-2',
              selected
                ? 'bg-accent text-accent-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            <ModalityIcon className="size-4" aria-hidden />
            {t(labelKey)}
          </button>
        );
      })}

      {selectedModel ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('home.selectModel')}
              className={cn(
                PILL_BASE,
                'max-w-full gap-2 bg-muted text-foreground hover:bg-muted/80',
              )}
            >
              <span className="max-w-[16rem] truncate">{selectedModel.displayName}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="max-h-72 min-w-[16rem] overflow-y-auto">
            {modelsInSelectedModality.map((model) => (
              <DropdownMenuItem
                key={model.key}
                onSelect={() => onModelChange(model.key)}
                className="justify-between"
              >
                <span className="min-w-0 truncate">{model.displayName}</span>
                {model.key === modelKey ? (
                  <Check className="shrink-0 text-accent" aria-hidden />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
