'use client';

/**
 * 画板节点（第 04 篇 4.4）。
 *
 * 渲染固定尺寸的边框容器，可作为其他节点的父容器与导出边界。顶部显示画板名标签。
 * 子节点由 React Flow 依 parentId 定位渲染于其上。
 *
 * @module components/canvas/nodes/FrameNode
 */

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FrameNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { NodeResizer } from '@xyflow/react';

function FrameNodeComponent({ data, selected }: NodeProps<CanvasFlowNode>) {
  const d = data as FrameNodeData;

  return (
    <>
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={120}
        minHeight={120}
        lineClassName="!border-accent"
        handleClassName="!size-2.5 !rounded-sm !border-accent !bg-card"
      />
      {/* 画板名标签悬于左上角外侧 */}
      <div className="absolute -top-6 left-0 max-w-full truncate text-xs font-medium text-muted-foreground">
        {d.name}
      </div>
      {/* 画板本体：不透明底色盖住其下的画布网格 + 细边框 + 轻阴影，使其成为浮于网格之上的
          独立画板，而非与网格融为一体。仅在显式开启 showGrid 时才叠加画板内参考点阵。 */}
      <div
        className="size-full rounded-md border border-border shadow-soft"
        style={{
          background: d.background,
          backgroundImage: d.showGrid
            ? 'radial-gradient(circle, hsl(var(--muted-foreground) / 0.18) 1px, transparent 1px)'
            : undefined,
          backgroundSize: d.showGrid ? '24px 24px' : undefined,
        }}
      />
    </>
  );
}

/** 记忆化画板节点。 */
export const FrameNode = memo(FrameNodeComponent);
