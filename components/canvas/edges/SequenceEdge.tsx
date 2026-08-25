'use client';

/**
 * 工作流序列边（第 04 篇画布连线）。
 *
 * 以贝塞尔曲线渲染一条带流动动画与末端箭头的强调色连线，并在中点叠加「段号」徽标：
 * 段号 = 源节点在其链中的序号 + 1，直观呈现「逐段首尾帧」的合成顺序。段号经状态库实时
 * 派生，链结构变化时自动更新。
 *
 * @module components/canvas/edges/SequenceEdge
 */

import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvas-store';
import { sequenceOrderIndex } from '@/lib/canvas/sequence';
import { EdgeDeleteButton } from './EdgeDeleteButton';

function SequenceEdgeComponent({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // 该边所代表「段」的序号：源节点链内 0 基序号 + 1；源不在链中时为 0（隐藏徽标）
  const segment = useCanvasStore((s) => sequenceOrderIndex(s.nodes, s.edges, source) + 1);

  // 悬停或选中：加粗连线并以删除按钮取代段号徽标，给出显式删除入口
  const active = hovered || (selected ?? false);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className="!stroke-accent"
        style={{ strokeWidth: active ? 3 : 2 }}
        interactionWidth={0}
      />
      {/* 透明加宽命中路径（置于可见线之上）：让细曲线易于点中与悬停；点击冒泡至 React Flow 完成选中 */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {active ? null : segment > 0 ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex size-5 items-center justify-center rounded-full border border-accent bg-card text-[10px] font-semibold text-accent shadow-soft"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {segment}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      <EdgeDeleteButton
        edgeId={id}
        x={labelX}
        y={labelY}
        show={active}
        onHoverChange={setHovered}
      />
    </>
  );
}

/** 记忆化序列边。 */
export const SequenceEdge = memo(SequenceEdgeComponent);
