'use client';

/**
 * 对齐参考线叠层（第 04 篇 4.8）。
 *
 * 拖动节点时实时显示对齐参考线（来自画布状态库的 guides）。参考线渲染于 React Flow
 * 的视口坐标空间（ViewportPortal），线宽随缩放反比修正以保持约 1px 的屏幕观感。
 *
 * @module components/canvas/AlignmentGuides
 */

import { ViewportPortal, useStore } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvas-store';

/**
 * 对齐参考线组件。须置于 ReactFlow 内部。
 */
export function AlignmentGuides() {
  const guides = useCanvasStore((s) => s.guides);
  const zoom = useStore((s) => s.transform[2]);

  if (guides.length === 0) return null;
  const thickness = 1 / zoom;

  return (
    <ViewportPortal>
      {guides.map((guide, index) => {
        if (guide.axis === 'vertical') {
          return (
            <div
              key={`v-${index}`}
              className="pointer-events-none absolute bg-accent"
              style={{
                left: guide.position,
                top: guide.start,
                width: thickness,
                height: guide.end - guide.start,
              }}
            />
          );
        }
        return (
          <div
            key={`h-${index}`}
            className="pointer-events-none absolute bg-accent"
            style={{
              left: guide.start,
              top: guide.position,
              width: guide.end - guide.start,
              height: thickness,
            }}
          />
        );
      })}
    </ViewportPortal>
  );
}
