'use client';

/**
 * 多选组变换层（第 04 篇 4.6）。
 *
 * React Flow 不原生提供「组整体缩放手柄」。本层在多选（≥2 节点）时根据选择集计算组
 * 包围盒、渲染组级缩放手柄，并在拖拽时把组变换按比例分解为对各成员位置 / 尺寸的批量
 * 更新。组整体移动由 React Flow 原生多选拖动处理，本层只补足整体缩放。
 *
 * @module components/canvas/SelectionTransformLayer
 */

import { useCallback, useRef } from 'react';
import { ViewportPortal, useReactFlow, useStore } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvas-store';
import { nodeBox } from '@/lib/canvas/node-mapper';
import { transformBoxWithinGroup, unionBounds, type Box } from '@/lib/canvas/geometry';
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from '@/lib/canvas/constants';

/** 八个缩放手柄方位。 */
type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: Array<{ dir: HandleDir; cx: number; cy: number; cursor: string }> = [
  { dir: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { dir: 'n', cx: 0.5, cy: 0, cursor: 'ns-resize' },
  { dir: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { dir: 'e', cx: 1, cy: 0.5, cursor: 'ew-resize' },
  { dir: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
  { dir: 's', cx: 0.5, cy: 1, cursor: 'ns-resize' },
  { dir: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { dir: 'w', cx: 0, cy: 0.5, cursor: 'ew-resize' },
];

/** 依手柄方位与指针位移，从旧组框算出新组框。 */
function resizeGroup(old: Box, dir: HandleDir, dx: number, dy: number): Box {
  let { x, y, width, height } = old;
  if (dir.includes('e')) width = Math.max(MIN_NODE_WIDTH, old.width + dx);
  if (dir.includes('s')) height = Math.max(MIN_NODE_HEIGHT, old.height + dy);
  if (dir.includes('w')) {
    width = Math.max(MIN_NODE_WIDTH, old.width - dx);
    x = old.x + (old.width - width);
  }
  if (dir.includes('n')) {
    height = Math.max(MIN_NODE_HEIGHT, old.height - dy);
    y = old.y + (old.height - height);
  }
  return { x, y, width, height };
}

/**
 * 组变换层。须置于 ReactFlow 内部。
 */
export function SelectionTransformLayer() {
  const reactFlow = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodes = useCanvasStore((s) => s.nodes);
  const updateNodesBatch = useCanvasStore((s) => s.updateNodesBatch);

  const dragRef = useRef<{
    dir: HandleDir;
    startGroup: Box;
    startPointer: { x: number; y: number };
    members: Array<{ id: string; box: Box }>;
  } | null>(null);

  const selectedNodes = nodes.filter((n) => selectedNodeIds.includes(n.id));
  const group = selectedNodes.length >= 2 ? unionBounds(selectedNodes.map(nodeBox)) : null;

  const onHandleDown = useCallback(
    (event: React.PointerEvent, dir: HandleDir) => {
      if (!group) return;
      event.stopPropagation();
      event.preventDefault();
      useCanvasStore.getState().beginHistoryTransaction('缩放选择');
      const startPointer = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const members = selectedNodes.map((n) => ({ id: n.id, box: nodeBox(n) }));
      dragRef.current = { dir, startGroup: group, startPointer, members };

      const onMove = (move: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const pointer = reactFlow.screenToFlowPosition({ x: move.clientX, y: move.clientY });
        const dx = pointer.x - drag.startPointer.x;
        const dy = pointer.y - drag.startPointer.y;
        const newGroup = resizeGroup(drag.startGroup, drag.dir, dx, dy);
        const changes = drag.members.map((member) => {
          const next = transformBoxWithinGroup(member.box, drag.startGroup, newGroup);
          return {
            id: member.id,
            patch: {
              position: { x: next.x, y: next.y },
              width: Math.max(MIN_NODE_WIDTH, next.width),
              height: Math.max(MIN_NODE_HEIGHT, next.height),
              style: {
                width: Math.max(MIN_NODE_WIDTH, next.width),
                height: Math.max(MIN_NODE_HEIGHT, next.height),
              },
            },
          };
        });
        updateNodesBatch(changes);
      };

      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        useCanvasStore.getState().endHistoryTransaction('缩放选择');
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [group, reactFlow, selectedNodes, updateNodesBatch],
  );

  if (!group) return null;
  const handleSize = 10 / zoom;
  const border = 1 / zoom;

  return (
    <ViewportPortal>
      <div
        className="pointer-events-none absolute"
        style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
      >
        <div className="absolute inset-0 border border-accent" style={{ borderWidth: border }} />
        {HANDLES.map((handle) => (
          <div
            key={handle.dir}
            onPointerDown={(e) => onHandleDown(e, handle.dir)}
            className="nodrag nopan pointer-events-auto absolute rounded-sm border border-accent bg-card"
            style={{
              width: handleSize,
              height: handleSize,
              left: handle.cx * group.width - handleSize / 2,
              top: handle.cy * group.height - handleSize / 2,
              cursor: handle.cursor,
              borderWidth: border,
            }}
          />
        ))}
      </div>
    </ViewportPortal>
  );
}
