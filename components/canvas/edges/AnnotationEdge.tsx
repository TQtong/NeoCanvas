'use client';

/**
 * 图片描述边（第 04 篇画布连线）。
 *
 * 以中性色虚线贝塞尔曲线连接「文字节点 → 被描述的图」，中点叠加「描述」徽标，弱化呈现以区别于
 * 强调色的工作流序列边。该边的源端文字内容会在生成序列视频时作为对应帧的提示词。
 *
 * @module components/canvas/edges/AnnotationEdge
 */

import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useTranslation } from '@/i18n';
import { EdgeDeleteButton } from './EdgeDeleteButton';

function AnnotationEdgeComponent({
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
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // 悬停或选中：加粗连线并以删除按钮取代「描述」徽标，给出显式删除入口
  const active = hovered || (selected ?? false);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className="!stroke-muted-foreground"
        style={{ strokeWidth: active ? 2.5 : 1.5, strokeDasharray: '5 4' }}
        interactionWidth={0}
      />
      {/* 透明加宽命中路径（置于可见线之上）：让细虚线易于点中与悬停；点击冒泡至 React Flow 完成选中 */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {active ? null : (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-soft"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {t('edge.description')}
          </div>
        </EdgeLabelRenderer>
      )}
      <EdgeDeleteButton edgeId={id} x={labelX} y={labelY} show={active} onHoverChange={setHovered} />
    </>
  );
}

/** 记忆化描述边。 */
export const AnnotationEdge = memo(AnnotationEdgeComponent);
