'use client';

/**
 * 可变换节点高阶封装（第 04 篇 4.5）。
 *
 * 统一为需要缩放 / 旋转的节点类型提供：
 * - 缩放：React Flow 的 NodeResizer，其尺寸 / 位置变更经 onNodesChange 流回状态库。
 * - 旋转：React Flow 未原生提供，自行渲染旋转手柄；拖拽时按节点中心到指针的角度写入
 *   `data.rotation`，由内容容器以 CSS 变换应用。
 *
 * 注意旋转引入的工程点（doc 4.5）：旋转后视觉包围盒与轴对齐盒不一致，命中与手柄
 * 定位采用轴对齐近似；旋转与缩放叠加时变换顺序固定为「先缩放（容器尺寸）后旋转」。
 *
 * @module components/canvas/TransformableNode
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import { RotateCw } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvas-store';
import { angleFromCenter } from '@/lib/canvas/geometry';
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from '@/lib/canvas/constants';
import { cn } from '@/lib/utils/cn';

/** 可变换节点属性。 */
export interface TransformableNodeProps {
  /** 节点 id。 */
  id: string;
  /** 是否选中（显示缩放 / 旋转手柄）。 */
  selected: boolean;
  /** 旋转角（度）。 */
  rotation: number;
  /** 节点内容。 */
  children: ReactNode;
  /** 是否启用缩放手柄。 */
  enableResize?: boolean;
  /** 是否启用旋转手柄。 */
  enableRotate?: boolean;
  /** 缩放时是否锁定等比。 */
  keepAspectRatio?: boolean;
  /** 最小宽。 */
  minWidth?: number;
  /** 最小高。 */
  minHeight?: number;
  /** 容器额外类名。 */
  className?: string;
}

/**
 * 可变换节点封装。
 */
export function TransformableNode({
  id,
  selected,
  rotation,
  children,
  enableResize = true,
  enableRotate = true,
  keepAspectRatio = false,
  minWidth = MIN_NODE_WIDTH,
  minHeight = MIN_NODE_HEIGHT,
  className,
}: TransformableNodeProps) {
  const reactFlow = useReactFlow();
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const rotatingRef = useRef(false);

  // 等比 / 自由缩放：按住 Shift 反转该类型的默认锁定（第 04 篇 4.5）。仅选中时监听，避免
  // 每个节点都常驻一对全局监听。
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    if (!selected || !enableResize) return;
    const onKey = (event: KeyboardEvent) => setShiftHeld(event.shiftKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [selected, enableResize]);
  const effectiveKeepAspect = shiftHeld ? !keepAspectRatio : keepAspectRatio;

  /** 旋转手柄拖拽：按指针相对节点中心的角度写入 rotation。 */
  const handleRotateStart = useCallback(
    (event: React.PointerEvent) => {
      event.stopPropagation();
      event.preventDefault();
      rotatingRef.current = true;

      const internalNode = reactFlow.getInternalNode(id);
      if (!internalNode) return;

      const onMove = (move: PointerEvent) => {
        if (!rotatingRef.current) return;
        const node = reactFlow.getInternalNode(id);
        if (!node) return;
        const width = node.measured.width ?? 0;
        const height = node.measured.height ?? 0;
        // 节点中心（flow 坐标）→ 屏幕坐标
        const centerFlow = {
          x: node.internals.positionAbsolute.x + width / 2,
          y: node.internals.positionAbsolute.y + height / 2,
        };
        const centerScreen = reactFlow.flowToScreenPosition(centerFlow);
        let angle = angleFromCenter(centerScreen, { x: move.clientX, y: move.clientY });
        // 按住 Shift 吸附到 15° 网格
        if (move.shiftKey) angle = Math.round(angle / 15) * 15;
        updateNodeData(id, { rotation: Math.round(angle) });
      };

      const onUp = () => {
        rotatingRef.current = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [id, reactFlow, updateNodeData],
  );

  return (
    <>
      {enableResize ? (
        <NodeResizer
          isVisible={selected}
          minWidth={minWidth}
          minHeight={minHeight}
          keepAspectRatio={effectiveKeepAspect}
          lineClassName="!border-accent"
          handleClassName="!size-2.5 !rounded-sm !border-accent !bg-card"
        />
      ) : null}

      <div
        className={cn('size-full', className)}
        style={{
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transformOrigin: 'center center',
        }}
      >
        {children}
      </div>

      {enableRotate && selected ? (
        <div
          role="slider"
          aria-label="旋转"
          aria-valuenow={Math.round(rotation)}
          tabIndex={-1}
          onPointerDown={handleRotateStart}
          className={cn(
            'nodrag nopan absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-9',
            'flex size-6 cursor-grab items-center justify-center rounded-full border border-accent bg-card text-accent shadow-soft',
            'active:cursor-grabbing',
          )}
        >
          <RotateCw className="size-3.5" />
        </div>
      ) : null}
    </>
  );
}
