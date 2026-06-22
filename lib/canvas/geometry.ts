/**
 * 画布几何工具。
 *
 * 集中实现坐标系换算与包围盒 / 旋转 / 组变换的纯数学，避免坐标系混用散落各处
 * （第 04 篇 4.2）。屏幕 ↔ flow 的换算遵循 React Flow 的视口变换：
 *   screen = flow * zoom + pan，故 flow = (screen - pan) / zoom。
 *
 * @module lib/canvas/geometry
 */

import type { Viewport } from '@/types';

/** 平面点。 */
export interface Point {
  x: number;
  y: number;
}

/** 轴对齐矩形框。 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 屏幕坐标 → flow 逻辑坐标。
 *
 * @param screen - 屏幕点（相对画布容器左上角的像素）
 * @param viewport - 当前视口
 * @returns flow 逻辑坐标点
 */
export function screenToFlowPoint(screen: Point, viewport: Viewport): Point {
  return {
    x: (screen.x - viewport.x) / viewport.zoom,
    y: (screen.y - viewport.y) / viewport.zoom,
  };
}

/**
 * flow 逻辑坐标 → 屏幕坐标。
 *
 * @param flow - flow 逻辑坐标点
 * @param viewport - 当前视口
 * @returns 屏幕坐标点
 */
export function flowToScreenPoint(flow: Point, viewport: Viewport): Point {
  return {
    x: flow.x * viewport.zoom + viewport.x,
    y: flow.y * viewport.zoom + viewport.y,
  };
}

/**
 * 把数值限制到 [min, max]。
 *
 * @param value - 输入
 * @param min - 下限
 * @param max - 上限
 * @returns 限制后的值
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 判断点是否落在框内（含边界）。
 */
export function pointInBox(point: Point, box: Box): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/**
 * 判断两框是否相交。
 */
export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * 判断框 a 是否完全包含框 b。
 */
export function boxContains(a: Box, b: Box): boolean {
  return (
    b.x >= a.x &&
    b.y >= a.y &&
    b.x + b.width <= a.x + a.width &&
    b.y + b.height <= a.y + a.height
  );
}

/**
 * 求一组框的并集包围盒。
 *
 * @param boxes - 框集合
 * @returns 并集包围盒；空集合返回 null
 */
export function unionBounds(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 框的中心点。 */
export function boxCenter(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * 绕中心旋转一个点。
 *
 * @param point - 待旋转点
 * @param center - 旋转中心
 * @param angleDeg - 角度（度，顺时针为正）
 * @returns 旋转后的点
 */
export function rotatePoint(point: Point, center: Point, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * 求旋转后矩形的轴对齐包围盒。用于旋转节点的命中区域与手柄定位近似（第 04 篇 4.5）。
 *
 * @param box - 未旋转的矩形（其中心为旋转中心）
 * @param angleDeg - 旋转角（度）
 * @returns 旋转后内容的轴对齐包围盒
 */
export function rotatedBounds(box: Box, angleDeg: number): Box {
  const center = boxCenter(box);
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((c) => rotatePoint(c, center, angleDeg));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/**
 * 计算两点间的角度（度），用于旋转手柄拖拽。
 *
 * @param center - 节点中心
 * @param pointer - 指针位置
 * @returns 角度（度，0 指向上方，顺时针增加）
 */
export function angleFromCenter(center: Point, pointer: Point): number {
  const rad = Math.atan2(pointer.y - center.y, pointer.x - center.x);
  // atan2 以正右为 0；转换为以正上为 0、顺时针为正
  return (rad * 180) / Math.PI + 90;
}

/**
 * 组变换：把成员框从旧的组包围盒比例映射到新的组包围盒，得到成员的新框。
 * 用于多选整体缩放时按比例更新各成员的位置与尺寸（第 04 篇 4.6）。
 *
 * @param member - 成员当前框
 * @param oldGroup - 变换前的组包围盒
 * @param newGroup - 变换后的组包围盒
 * @returns 成员变换后的框
 */
export function transformBoxWithinGroup(member: Box, oldGroup: Box, newGroup: Box): Box {
  const sx = oldGroup.width === 0 ? 1 : newGroup.width / oldGroup.width;
  const sy = oldGroup.height === 0 ? 1 : newGroup.height / oldGroup.height;
  return {
    x: newGroup.x + (member.x - oldGroup.x) * sx,
    y: newGroup.y + (member.y - oldGroup.y) * sy,
    width: member.width * sx,
    height: member.height * sy,
  };
}

/**
 * 将一组归一化（去中心化）的手绘采样点转换为缓存的 SVG path d 串。这里只做平滑，
 * 具体见 lib/canvas/drawing。占位以保持几何模块自洽。
 *
 * @param points - 局部坐标点序列
 * @param smoothing - 平滑系数 0..1
 * @returns SVG path d 串
 */
export function pointsToSmoothPath(points: Point[], smoothing: number): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0]!;
    // 单点画一个微小圆点
    return `M ${p.x} ${p.y} l 0.01 0`;
  }
  const k = clamp(smoothing, 0, 1) * 0.2;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1] ?? curr;
    const prevPrev = points[i - 2] ?? prev;
    const cp1x = prev.x + (curr.x - prevPrev.x) * k;
    const cp1y = prev.y + (curr.y - prevPrev.y) * k;
    const cp2x = curr.x - (next.x - prev.x) * k;
    const cp2y = curr.y - (next.y - prev.y) * k;
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${curr.x} ${curr.y}`;
  }
  return d;
}
