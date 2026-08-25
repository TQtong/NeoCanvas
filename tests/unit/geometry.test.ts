import { describe, expect, it } from 'vitest';
import {
  angleFromCenter,
  boxContains,
  boxesIntersect,
  flowToScreenPoint,
  pointInBox,
  rotatedBounds,
  rotatePoint,
  screenToFlowPoint,
  transformBoxWithinGroup,
  unionBounds,
} from '@/lib/canvas/geometry';

describe('画布几何', () => {
  it('屏幕与 flow 坐标可以精确往返', () => {
    const viewport = { x: -320, y: 140, zoom: 1.75 };
    const flow = { x: 812.5, y: -42.25 };
    const screen = flowToScreenPoint(flow, viewport);
    expect(screenToFlowPoint(screen, viewport)).toEqual(flow);
  });

  it('旋转包围盒与角度方向符合画布约定', () => {
    const rotated = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(10);
    const bounds = rotatedBounds({ x: 0, y: 0, width: 100, height: 50 }, 90);
    expect(bounds.x).toBeCloseTo(25);
    expect(bounds.y).toBeCloseTo(-25);
    expect(bounds.width).toBeCloseTo(50);
    expect(bounds.height).toBeCloseTo(100);
    expect(angleFromCenter({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(0);
    expect(angleFromCenter({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(90);
  });

  it('包围盒命中、相交、包含和并集覆盖边界', () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(pointInBox({ x: 100, y: 100 }, outer)).toBe(true);
    expect(boxesIntersect(outer, { x: 99, y: 99, width: 10, height: 10 })).toBe(true);
    expect(boxesIntersect(outer, { x: 100, y: 100, width: 10, height: 10 })).toBe(false);
    expect(boxContains(outer, { x: 20, y: 20, width: 30, height: 30 })).toBe(true);
    expect(unionBounds([outer, { x: -20, y: 50, width: 10, height: 80 }])).toEqual({
      x: -20,
      y: 0,
      width: 120,
      height: 130,
    });
  });

  it('多选缩放按组包围盒比例映射成员', () => {
    expect(
      transformBoxWithinGroup(
        { x: 20, y: 10, width: 40, height: 20 },
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 10, y: 20, width: 200, height: 150 },
      ),
    ).toEqual({ x: 50, y: 50, width: 80, height: 60 });
  });
});
