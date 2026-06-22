/**
 * 拖动对齐参考线与吸附计算（第 04 篇 4.8）。
 *
 * 拖动节点时实时计算其边与中线同其他节点 / 画板的对齐关系，达到阈值时给出吸附偏移
 * 与参考线段供渲染；交互结束后清除。逻辑为纯函数，便于测试。
 *
 * @module lib/canvas/alignment
 */

import type { Box } from './geometry';

/** 一条对齐参考线段（flow 坐标）。 */
export interface AlignmentGuide {
  /** 轴向：vertical 表示一条竖线（固定 x），horizontal 表示一条横线（固定 y）。 */
  axis: 'vertical' | 'horizontal';
  /** 该线在固定轴上的位置（flow 坐标）。 */
  position: number;
  /** 线段沿另一轴的起点（flow 坐标）。 */
  start: number;
  /** 线段沿另一轴的终点（flow 坐标）。 */
  end: number;
}

/** 对齐计算结果。 */
export interface AlignmentResult {
  /** X 轴吸附后的盒左上角 x（未吸附则为原值）。 */
  x: number;
  /** Y 轴吸附后的盒左上角 y（未吸附则为原值）。 */
  y: number;
  /** 需要渲染的参考线段。 */
  guides: AlignmentGuide[];
}

/** 某一轴上一条候选对齐线（取自盒的左/中/右 或 上/中/下）。 */
interface AxisLine {
  /** 线位置。 */
  value: number;
  /** 该盒在另一轴上的范围最小值（用于绘制线段长度）。 */
  spanMin: number;
  /** 该盒在另一轴上的范围最大值。 */
  spanMax: number;
}

/** 取盒在 X 轴上的三条候选线（左、中、右）。 */
function xLines(box: Box): AxisLine[] {
  const spanMin = box.y;
  const spanMax = box.y + box.height;
  return [
    { value: box.x, spanMin, spanMax },
    { value: box.x + box.width / 2, spanMin, spanMax },
    { value: box.x + box.width, spanMin, spanMax },
  ];
}

/** 取盒在 Y 轴上的三条候选线（上、中、下）。 */
function yLines(box: Box): AxisLine[] {
  const spanMin = box.x;
  const spanMax = box.x + box.width;
  return [
    { value: box.y, spanMin, spanMax },
    { value: box.y + box.height / 2, spanMin, spanMax },
    { value: box.y + box.height, spanMin, spanMax },
  ];
}

/**
 * 计算拖动盒相对一组参照盒的对齐吸附与参考线。
 *
 * @param dragged - 正在拖动的盒（flow 坐标）
 * @param others - 参照盒集合（其他节点 / 画板）
 * @param threshold - 吸附阈值（flow 坐标，已由屏幕阈值换算）
 * @returns 吸附后的左上角坐标与参考线段
 */
export function computeAlignment(dragged: Box, others: Box[], threshold: number): AlignmentResult {
  const guides: AlignmentGuide[] = [];

  const draggedXLines = xLines(dragged);
  const draggedYLines = yLines(dragged);

  // X 轴：寻找最近的可吸附线
  let bestX: { delta: number; diff: number; guide: AlignmentGuide } | null = null;
  for (const other of others) {
    for (const ol of xLines(other)) {
      for (const dl of draggedXLines) {
        const diff = ol.value - dl.value;
        const adiff = Math.abs(diff);
        if (adiff <= threshold && (bestX === null || adiff < bestX.diff)) {
          bestX = {
            delta: diff,
            diff: adiff,
            guide: {
              axis: 'vertical',
              position: ol.value,
              start: Math.min(ol.spanMin, dl.spanMin),
              end: Math.max(ol.spanMax, dl.spanMax),
            },
          };
        }
      }
    }
  }

  // Y 轴：同理
  let bestY: { delta: number; diff: number; guide: AlignmentGuide } | null = null;
  for (const other of others) {
    for (const ol of yLines(other)) {
      for (const dl of draggedYLines) {
        const diff = ol.value - dl.value;
        const adiff = Math.abs(diff);
        if (adiff <= threshold && (bestY === null || adiff < bestY.diff)) {
          bestY = {
            delta: diff,
            diff: adiff,
            guide: {
              axis: 'horizontal',
              position: ol.value,
              start: Math.min(ol.spanMin, dl.spanMin),
              end: Math.max(ol.spanMax, dl.spanMax),
            },
          };
        }
      }
    }
  }

  if (bestX) guides.push(bestX.guide);
  if (bestY) guides.push(bestY.guide);

  return {
    x: dragged.x + (bestX?.delta ?? 0),
    y: dragged.y + (bestY?.delta ?? 0),
    guides,
  };
}
