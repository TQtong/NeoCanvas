'use client';

/**
 * 画布背景网格（第 04 篇 4.8）。
 *
 * 以 React Flow 的 Background 组件渲染点状 / 线状 / 十字背景，由画布状态库的背景设置
 * 驱动显隐与样式（工具栏「画板 / 网格」工具切换）。
 *
 * @module components/canvas/BackgroundGrid
 */

import { Background, BackgroundVariant as RFBackgroundVariant } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvas-store';

/**
 * 背景网格组件。须置于 ReactFlow 内部。
 */
export function BackgroundGrid() {
  const background = useCanvasStore((s) => s.background);

  if (background.variant === 'none') return null;

  const variant =
    background.variant === 'lines'
      ? RFBackgroundVariant.Lines
      : background.variant === 'cross'
        ? RFBackgroundVariant.Cross
        : RFBackgroundVariant.Dots;

  return (
    <Background
      variant={variant}
      gap={background.gap}
      size={background.variant === 'dots' ? 1.5 : 1}
      color="hsl(var(--muted-foreground) / 0.22)"
    />
  );
}
