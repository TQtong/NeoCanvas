'use client';

/**
 * 连线删除按钮（第 04 篇画布连线）。
 *
 * 在边中点叠加一个红色「×」按钮，点击即删除该条连线——序列边与描述边共用。它解决「连错了
 * 却不知如何删连线」的困惑：连线本身是细曲线，难以精确点中再按 Delete；此按钮在悬停 / 选中
 * 连线时显现，提供显式、可发现的删除入口（与按 Delete 键并行有效）。
 *
 * 经 {@link EdgeLabelRenderer} 渲染于覆盖层（屏幕坐标），故须显式 `pointer-events-auto` 才可
 * 点击（覆盖层默认 `pointer-events:none`）；`nodrag nopan` 避免触发画布平移 / 拖拽。
 *
 * @module components/canvas/edges/EdgeDeleteButton
 */

import { EdgeLabelRenderer } from '@xyflow/react';
import { X } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvas-store';
import { useTranslation } from '@/i18n';

/** 删除按钮属性。 */
export interface EdgeDeleteButtonProps {
  /** 目标边 id。 */
  edgeId: string;
  /** 按钮中心 X（边中点，屏幕坐标）。 */
  x: number;
  /** 按钮中心 Y（边中点，屏幕坐标）。 */
  y: number;
  /** 是否显示（通常为「悬停或选中」）。 */
  show: boolean;
  /** 悬停态变化回调：让按钮自身的悬停也维持父边的显示态，避免移到按钮上时闪退。 */
  onHoverChange?: (hovered: boolean) => void;
}

/**
 * 连线删除按钮。须在自定义边组件内渲染。
 */
export function EdgeDeleteButton({ edgeId, x, y, show, onHoverChange }: EdgeDeleteButtonProps) {
  const { t } = useTranslation();
  if (!show) return null;
  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        className="nodrag nopan pointer-events-auto absolute flex size-5 items-center justify-center rounded-full border border-danger bg-card text-danger shadow-soft transition-colors hover:bg-danger hover:text-danger-foreground"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        title={t('edge.delete')}
        aria-label={t('edge.delete')}
        onMouseEnter={() => onHoverChange?.(true)}
        onMouseLeave={() => onHoverChange?.(false)}
        onClick={(event) => {
          // 阻止冒泡到边 / 画布，避免点击被解读为选中或平移
          event.stopPropagation();
          useCanvasStore.getState().removeEdges([edgeId]);
        }}
      >
        <X className="size-3" strokeWidth={2.5} />
      </button>
    </EdgeLabelRenderer>
  );
}
