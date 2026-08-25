'use client';

/**
 * 媒体候选关系边。
 *
 * 用于连接主媒体与其候选历史，采用独立的短虚线与「候选」标签，避免与工作流序列线、
 * 描述线和生成血缘线混淆。
 *
 * @module components/canvas/edges/MediaCandidateEdge
 */

import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { EdgeDeleteButton } from './EdgeDeleteButton';

function MediaCandidateEdgeComponent({
  id,
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
  const active = hovered || (selected ?? false);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: 'hsl(var(--accent))',
          strokeWidth: active ? 2.5 : 1.75,
          strokeDasharray: '2 7',
          strokeLinecap: 'round',
          opacity: active ? 1 : 0.78,
        }}
        interactionWidth={0}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {active ? null : (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded-full border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent shadow-soft backdrop-blur"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            候选
          </div>
        </EdgeLabelRenderer>
      )}
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

/** 记忆化媒体候选关系边。 */
export const MediaCandidateEdge = memo(MediaCandidateEdgeComponent);
