'use client';

/**
 * 手绘节点（第 04 篇 4.4）。
 *
 * 以 SVG path 渲染笔迹，路径由手绘交互采样并平滑而来；坐标为节点局部坐标，渲染时
 * 按节点尺寸缩放（preserveAspectRatio none）。
 *
 * @module components/canvas/nodes/DrawingNode
 */

import { memo, useMemo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { DrawingNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { pointsToSmoothPath } from '@/lib/canvas/geometry';
import { TransformableNode } from '../TransformableNode';

function DrawingNodeComponent({ id, data, selected, width, height }: NodeProps<CanvasFlowNode>) {
  const d = data as DrawingNodeData;

  // 优先使用缓存的 path，缺失时按点序列重算
  const pathData = useMemo(() => {
    if (d.path) return d.path;
    return pointsToSmoothPath(d.points, d.smoothing);
  }, [d.path, d.points, d.smoothing]);

  // viewBox 取点序列的包围盒，使路径在节点尺寸内自适应
  const viewBox = useMemo(() => {
    if (d.points.length === 0) return `0 0 ${width ?? 200} ${height ?? 200}`;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of d.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = d.strokeWidth;
    return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  }, [d.points, d.strokeWidth, width, height]);

  return (
    <TransformableNode id={id} selected={Boolean(selected)} rotation={d.rotation}>
      <svg
        width="100%"
        height="100%"
        viewBox={viewBox}
        preserveAspectRatio="none"
        className="overflow-visible"
        style={{ opacity: d.opacity }}
      >
        <path
          d={pathData}
          fill="none"
          stroke={d.stroke}
          strokeWidth={d.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </TransformableNode>
  );
}

/** 记忆化手绘节点。 */
export const DrawingNode = memo(DrawingNodeComponent);
