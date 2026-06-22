'use client';

/**
 * 无限画布容器（第 04 篇第四节）。
 *
 * 以 `@xyflow/react` 的 ReactFlow 为底座，把状态库的节点 / 边受控渲染，绑定变更回流、
 * 视口持久化、按工具切换的指针行为、拖动对齐参考线与吸附，并叠加背景、对齐线与组变换层。
 *
 * @module components/canvas/CanvasContainer
 */

import { useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  type OnMove,
  type Viewport as RFViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '@/stores/canvas-store';
import { nodeBox, type CanvasFlowNode, type CanvasFlowEdge } from '@/lib/canvas/node-mapper';
import { computeAlignment } from '@/lib/canvas/alignment';
import { ZOOM_MAX, ZOOM_MIN, SNAP_THRESHOLD, DEFAULT_VIEWPORT } from '@/lib/canvas/constants';
import { nodeTypes } from './node-registry';
import { BackgroundGrid } from './BackgroundGrid';
import { AlignmentGuides } from './AlignmentGuides';
import { SelectionTransformLayer } from './SelectionTransformLayer';
import { NodeFloatingToolbar } from './NodeFloatingToolbar';
import { useCanvasTools } from './use-canvas-tools';
import { useTranslation } from '@/i18n';

/** 容器属性。 */
export interface CanvasContainerProps {
  /** 初始视口（恢复上次）。 */
  initialViewport: RFViewport;
}

/**
 * 画布容器。须置于 ReactFlowProvider 内。
 */
export function CanvasContainer({ initialViewport }: CanvasContainerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const isEmpty = useCanvasStore((s) => s.nodes.length === 0);

  const handleNodesChange = useCanvasStore((s) => s.handleNodesChange);
  const handleEdgesChange = useCanvasStore((s) => s.handleEdgesChange);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const setGuides = useCanvasStore((s) => s.setGuides);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const setEditingNode = useCanvasStore((s) => s.setEditingNode);

  useCanvasTools(wrapperRef);

  // 按工具切换指针行为
  const isCreationTool =
    activeTool === 'shape' || activeTool === 'draw' || activeTool === 'text' || activeTool === 'frame';
  const isPanTool = activeTool === 'pan';

  const onMove = useCallback<OnMove>(
    (_event, viewport) => {
      setViewport(viewport);
    },
    [setViewport],
  );

  const onMoveEnd = useCallback<OnMove>(
    (_event, viewport) => {
      setViewport(viewport, { persist: true });
    },
    [setViewport],
  );

  // 拖动时计算对齐参考线（视觉提示）
  const onNodeDrag = useCallback(
    (_event: MouseEvent | TouchEvent, node: CanvasFlowNode) => {
      const others = useCanvasStore
        .getState()
        .nodes.filter((n) => n.id !== node.id && !n.selected)
        .map(nodeBox);
      const zoom = useCanvasStore.getState().viewport.zoom || 1;
      const result = computeAlignment(nodeBox(node), others, SNAP_THRESHOLD / zoom);
      setGuides(result.guides);
    },
    [setGuides],
  );

  // 拖动结束：吸附到对齐位置并清除参考线
  const onNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: CanvasFlowNode) => {
      const others = useCanvasStore
        .getState()
        .nodes.filter((n) => n.id !== node.id && !n.selected)
        .map(nodeBox);
      const zoom = useCanvasStore.getState().viewport.zoom || 1;
      const result = computeAlignment(nodeBox(node), others, SNAP_THRESHOLD / zoom);
      if (result.x !== node.position.x || result.y !== node.position.y) {
        updateNode(node.id, { position: { x: result.x, y: result.y } });
      }
      setGuides([]);
    },
    [setGuides, updateNode],
  );

  const onPaneClick = useCallback(() => {
    clearSelection();
    setEditingNode(null);
  }, [clearSelection, setEditingNode]);

  const defaultViewport = useMemo<RFViewport>(
    () => initialViewport ?? DEFAULT_VIEWPORT,
    [initialViewport],
  );

  return (
    <div ref={wrapperRef} className="size-full" data-tool={activeTool}>
      <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        onPaneClick={onPaneClick}
        defaultViewport={defaultViewport}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        nodesConnectable={false}
        nodesDraggable={!isCreationTool && !isPanTool}
        elementsSelectable={!isCreationTool}
        panOnDrag={isPanTool ? true : isCreationTool ? false : [1, 2]}
        selectionOnDrag={!isCreationTool && !isPanTool}
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        selectNodesOnDrag={false}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        className="bg-background"
      >
        <BackgroundGrid />
        <AlignmentGuides />
        <SelectionTransformLayer />
        <NodeFloatingToolbar />
      </ReactFlow>

      {isEmpty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-xs text-center text-sm text-muted-foreground">
            {t('design.emptyCanvas')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
