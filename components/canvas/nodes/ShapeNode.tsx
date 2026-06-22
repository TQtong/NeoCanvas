'use client';

/**
 * 形状节点（第 04 篇 4.4）。
 *
 * 以内联 SVG 渲染矩形 / 圆 / 三角 / 菱形 / 线 / 箭头，支持填充、描边、圆角、描边样式。
 *
 * @module components/canvas/nodes/ShapeNode
 */

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { ShapeNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { TransformableNode } from '../TransformableNode';

/** 描边样式 → SVG dash 数组。 */
function dashArray(style: ShapeNodeData['strokeStyle'], width: number): string | undefined {
  if (style === 'dashed') return `${width * 3} ${width * 2}`;
  if (style === 'dotted') return `${width} ${width * 2}`;
  return undefined;
}

/** 渲染具体形状的 SVG 元素。 */
function renderShape(d: ShapeNodeData, w: number, h: number) {
  const sw = d.strokeWidth;
  const inset = sw / 2;
  const common = {
    fill: d.fill,
    stroke: d.stroke,
    strokeWidth: sw,
    strokeDasharray: dashArray(d.strokeStyle, sw),
    opacity: d.opacity,
  };
  switch (d.shape) {
    case 'ellipse':
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - inset} ry={h / 2 - inset} {...common} />;
    case 'triangle':
      return (
        <polygon
          points={`${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`}
          strokeLinejoin="round"
          {...common}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`}
          strokeLinejoin="round"
          {...common}
        />
      );
    case 'line':
      return (
        <line
          x1={inset}
          y1={h / 2}
          x2={w - inset}
          y2={h / 2}
          stroke={d.stroke}
          strokeWidth={sw}
          strokeDasharray={dashArray(d.strokeStyle, sw)}
          strokeLinecap="round"
          opacity={d.opacity}
        />
      );
    case 'arrow':
      return (
        <g opacity={d.opacity}>
          <line
            x1={inset}
            y1={h / 2}
            x2={w - sw * 4}
            y2={h / 2}
            stroke={d.stroke}
            strokeWidth={sw}
            strokeDasharray={dashArray(d.strokeStyle, sw)}
            strokeLinecap="round"
          />
          <polygon
            points={`${w - inset},${h / 2} ${w - sw * 4},${h / 2 - sw * 2} ${w - sw * 4},${h / 2 + sw * 2}`}
            fill={d.stroke}
          />
        </g>
      );
    case 'rectangle':
    default:
      return (
        <rect
          x={inset}
          y={inset}
          width={Math.max(0, w - sw)}
          height={Math.max(0, h - sw)}
          rx={d.cornerRadius}
          ry={d.cornerRadius}
          {...common}
        />
      );
  }
}

function ShapeNodeComponent({ id, data, selected, width, height }: NodeProps<CanvasFlowNode>) {
  const d = data as ShapeNodeData;
  const w = width ?? 160;
  const h = height ?? 120;

  return (
    <TransformableNode id={id} selected={Boolean(selected)} rotation={d.rotation}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="overflow-visible"
      >
        {renderShape(d, w, h)}
      </svg>
    </TransformableNode>
  );
}

/** 记忆化形状节点。 */
export const ShapeNode = memo(ShapeNodeComponent);
