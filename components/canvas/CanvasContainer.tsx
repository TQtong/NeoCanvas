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
  ConnectionLineType,
  type Connection,
  type IsValidConnection,
  type OnConnect,
  type OnMove,
  type Viewport as RFViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '@/stores/canvas-store';
import { nodeBox, type CanvasFlowNode, type CanvasFlowEdge } from '@/lib/canvas/node-mapper';
import { computeAlignment } from '@/lib/canvas/alignment';
import { isSequenceable, wouldCreateSequenceCycle } from '@/lib/canvas/sequence';
import { isAnnotationSource } from '@/lib/canvas/annotation';
import { ZOOM_MAX, ZOOM_MIN, SNAP_THRESHOLD, DEFAULT_VIEWPORT } from '@/lib/canvas/constants';
import { nodeTypes } from './node-registry';
import { edgeTypes } from './edge-registry';
import { BackgroundGrid } from './BackgroundGrid';
import { AlignmentGuides } from './AlignmentGuides';
import { SelectionTransformLayer } from './SelectionTransformLayer';
import { NodeFloatingToolbar } from './NodeFloatingToolbar';
import { MultiSelectToolbar } from './MultiSelectToolbar';
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
  // 组拖动：记录被拖节点上一帧位置，用于把同组未被一起拖动的成员按相同位移跟随
  const groupDragRef = useRef<{ x: number; y: number } | null>(null);
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
    activeTool === 'shape' ||
    activeTool === 'draw' ||
    activeTool === 'text' ||
    activeTool === 'frame';
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

  // 拖动开始：若拖的是组内节点，记录起始位置以便组联动
  const onNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, node: CanvasFlowNode) => {
    groupDragRef.current = node.data.groupId ? { x: node.position.x, y: node.position.y } : null;
  }, []);

  // 拖动时：组联动（同组成员按相同位移跟随）+ 计算对齐参考线
  const onNodeDrag = useCallback(
    (_event: MouseEvent | TouchEvent, node: CanvasFlowNode, draggedNodes: CanvasFlowNode[]) => {
      // 组联动：拖动组内任一节点，未被 React Flow 一起拖动的同组成员按相同位移跟随移动
      const gid = node.data.groupId;
      const last = groupDragRef.current;
      if (gid && last) {
        const dx = node.position.x - last.x;
        const dy = node.position.y - last.y;
        if (dx !== 0 || dy !== 0) {
          const draggedIds = new Set(draggedNodes.map((n) => n.id));
          const store = useCanvasStore.getState();
          for (const m of store.nodes) {
            if (m.id !== node.id && m.data.groupId === gid && !draggedIds.has(m.id)) {
              store.updateNode(m.id, {
                position: { x: m.position.x + dx, y: m.position.y + dy },
              });
            }
          }
          groupDragRef.current = { x: node.position.x, y: node.position.y };
        }
      }

      // 对齐参考线（视觉提示）
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
      groupDragRef.current = null;
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

  // 连线落定：按源节点类型分流——文字节点 → 图为「描述边」（一对一），图 → 图为「工作流序列边」
  //（n:m 自由连接、去重、拒环等约束由状态库处理）
  const onConnect = useCallback<OnConnect>((connection) => {
    const { source, target, sourceHandle, targetHandle } = connection;
    if (!source || !target) return;
    const store = useCanvasStore.getState();
    const sourceNode = store.nodes.find((n) => n.id === source);
    if (sourceNode && isAnnotationSource(sourceNode)) {
      store.addAnnotationEdge(source, target, sourceHandle, targetHandle);
    } else {
      store.addSequenceEdge(source, target, sourceHandle, targetHandle);
    }
  }, []);

  // 连线校验（提供拖拽时的有效性反馈与端口高亮）：
  // - 文字 → 图片 / 视频：描述边；
  // - 图片 / 视频 → 图片 / 视频：序列边（非自连、不成环）。
  const isValidConnection = useCallback<IsValidConnection<CanvasFlowEdge>>((edgeOrConn) => {
    const { source, target } = edgeOrConn as Connection;
    if (!source || !target || source === target) return false;
    const { nodes: currentNodes, edges: currentEdges } = useCanvasStore.getState();
    const sourceNode = currentNodes.find((n) => n.id === source);
    const targetNode = currentNodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) return false;
    // 文字节点只能作为描述源，连到图片 / 视频
    if (isAnnotationSource(sourceNode)) return isSequenceable(targetNode);
    // 图片 / 视频之间：序列边，拒自连 / 成环
    if (isSequenceable(sourceNode)) {
      return isSequenceable(targetNode) && !wouldCreateSequenceCycle(currentEdges, source, target);
    }
    return false;
  }, []);

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
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        onPaneClick={onPaneClick}
        defaultViewport={defaultViewport}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        connectionLineType={ConnectionLineType.Bezier}
        connectionRadius={28}
        connectionLineStyle={{ stroke: 'hsl(var(--accent))', strokeWidth: 2 }}
        nodesConnectable={!isCreationTool && !isPanTool}
        nodesDraggable={!isCreationTool && !isPanTool}
        elementsSelectable={!isCreationTool}
        panOnDrag={isPanTool ? true : isCreationTool ? false : [1, 2]}
        selectionOnDrag={!isCreationTool && !isPanTool}
        panOnScroll
        zoomOnScroll
        zoomOnPinch
        selectNodesOnDrag={false}
        elevateNodesOnSelect={false}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        className="bg-background"
      >
        <BackgroundGrid />
        <AlignmentGuides />
        <SelectionTransformLayer />
        <NodeFloatingToolbar />
        <MultiSelectToolbar />
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
