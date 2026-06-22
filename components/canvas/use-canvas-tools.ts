'use client';

/**
 * 画布交互状态机（第 04 篇 4.9）。
 *
 * 底部工具栏的工具背后是一个交互状态机：当前激活工具决定指针在画布上的行为。本钩子
 * 在画布容器挂载原生指针监听，按工具实现「点击落字 / 落画板」「拖拽绘制形状」「自由
 * 手绘」三类创建动作；上传与 AI 工具由工具栏直接驱动。创建完成后一般自动回落选择工具
 * （连续创建模式除外）。
 *
 * @module components/canvas/use-canvas-tools
 */

import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvas-store';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { createDefaultNodeData, DEFAULT_NODE_SIZE } from '@/lib/canvas/constants';
import { pointsToSmoothPath } from '@/lib/canvas/geometry';
import type { DrawingPoint } from '@/types';
import { uuid } from '@/lib/utils/id';

/** 判断事件目标是否为画布背景（pane）。 */
function isPaneTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains('react-flow__pane');
}

/**
 * 在画布容器上装配工具交互。
 *
 * @param wrapperRef - 包裹 ReactFlow 的容器元素引用
 */
export function useCanvasTools(wrapperRef: React.RefObject<HTMLDivElement | null>): void {
  const reactFlow = useReactFlow();

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const store = useCanvasStore;
    // 创建过程中的瞬态
    let creatingId: string | null = null;
    let origin = { x: 0, y: 0 };
    let drawingPoints: DrawingPoint[] = [];
    let mode: 'shape' | 'draw' | null = null;

    const finishAndMaybeReset = () => {
      if (!store.getState().continuousCreate) {
        store.getState().setTool('select');
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const tool = store.getState().activeTool;
      const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      // 点击落字
      if (tool === 'text' && isPaneTarget(event.target)) {
        const size = DEFAULT_NODE_SIZE.text;
        const id = uuid();
        const node: CanvasFlowNode = {
          id,
          type: 'text',
          position: { x: flow.x, y: flow.y },
          data: createDefaultNodeData('text'),
          width: size.width,
          height: size.height,
          zIndex: 0,
          style: { width: size.width, height: size.height },
        };
        store.getState().addNode(node, { select: true });
        store.getState().setEditingNode(id);
        finishAndMaybeReset();
        return;
      }

      // 点击落画板
      if (tool === 'frame' && isPaneTarget(event.target)) {
        const size = DEFAULT_NODE_SIZE.frame;
        const id = uuid();
        const node: CanvasFlowNode = {
          id,
          type: 'frame',
          position: { x: flow.x - size.width / 2, y: flow.y - size.height / 2 },
          data: createDefaultNodeData('frame'),
          width: size.width,
          height: size.height,
          zIndex: -1,
          style: { width: size.width, height: size.height },
        };
        store.getState().addNode(node, { select: true });
        finishAndMaybeReset();
        return;
      }

      // 拖拽绘制形状
      if (tool === 'shape' && isPaneTarget(event.target)) {
        mode = 'shape';
        origin = flow;
        const id = uuid();
        creatingId = id;
        const node: CanvasFlowNode = {
          id,
          type: 'shape',
          position: { x: flow.x, y: flow.y },
          data: createDefaultNodeData('shape'),
          width: 1,
          height: 1,
          zIndex: 0,
          style: { width: 1, height: 1 },
        };
        store.getState().addNode(node, { select: true });
        wrapper.setPointerCapture(event.pointerId);
        return;
      }

      // 自由手绘
      if (tool === 'draw' && isPaneTarget(event.target)) {
        mode = 'draw';
        origin = flow;
        drawingPoints = [{ x: 0, y: 0, pressure: event.pressure || 1 }];
        const id = uuid();
        creatingId = id;
        const node: CanvasFlowNode = {
          id,
          type: 'drawing',
          position: { x: flow.x, y: flow.y },
          data: createDefaultNodeData('drawing', { points: drawingPoints, path: '' }),
          width: 1,
          height: 1,
          zIndex: 0,
          style: { width: 1, height: 1 },
        };
        store.getState().addNode(node, { select: true });
        wrapper.setPointerCapture(event.pointerId);
        return;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!creatingId || !mode) return;
      const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      if (mode === 'shape') {
        const x = Math.min(origin.x, flow.x);
        const y = Math.min(origin.y, flow.y);
        const width = Math.max(1, Math.abs(flow.x - origin.x));
        const height = Math.max(1, Math.abs(flow.y - origin.y));
        store.getState().updateNode(creatingId, {
          position: { x, y },
          width,
          height,
          style: { width, height },
        });
      } else if (mode === 'draw') {
        drawingPoints.push({ x: flow.x - origin.x, y: flow.y - origin.y, pressure: event.pressure || 1 });
        store.getState().updateNodeData(creatingId, {
          points: [...drawingPoints],
          path: pointsToSmoothPath(drawingPoints, 0.5),
        });
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!creatingId || !mode) return;
      const id = creatingId;

      if (mode === 'shape') {
        const node = store.getState().nodes.find((n) => n.id === id);
        // 拖拽过小则视为误操作，移除
        if (node && ((node.width ?? 0) < 4 || (node.height ?? 0) < 4)) {
          store.getState().removeNodes([id]);
        }
      } else if (mode === 'draw') {
        // 归一化：把点序列平移到从 0 开始，并据包围盒设置节点位置与尺寸
        if (drawingPoints.length < 2) {
          store.getState().removeNodes([id]);
        } else {
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const p of drawingPoints) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
          const normalized = drawingPoints.map((p) => ({ x: p.x - minX, y: p.y - minY, pressure: p.pressure }));
          const width = Math.max(1, maxX - minX);
          const height = Math.max(1, maxY - minY);
          store.getState().updateNode(id, {
            position: { x: origin.x + minX, y: origin.y + minY },
            width,
            height,
            style: { width, height },
            data: {
              ...createDefaultNodeData('drawing'),
              points: normalized,
              path: pointsToSmoothPath(normalized, 0.5),
            },
          });
        }
      }

      try {
        wrapper.releasePointerCapture(event.pointerId);
      } catch {
        // 指针捕获可能已释放，忽略
      }
      creatingId = null;
      mode = null;
      drawingPoints = [];
      finishAndMaybeReset();
    };

    wrapper.addEventListener('pointerdown', onPointerDown);
    wrapper.addEventListener('pointermove', onPointerMove);
    wrapper.addEventListener('pointerup', onPointerUp);

    return () => {
      wrapper.removeEventListener('pointerdown', onPointerDown);
      wrapper.removeEventListener('pointermove', onPointerMove);
      wrapper.removeEventListener('pointerup', onPointerUp);
    };
  }, [reactFlow, wrapperRef]);
}
