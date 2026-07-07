'use client';

/**
 * 无限画布容器（第 04 篇第四节）。
 *
 * 以 `@xyflow/react` 的 ReactFlow 为底座，把状态库的节点 / 边受控渲染，绑定变更回流、
 * 视口持久化、按工具切换的指针行为、拖动对齐参考线与吸附，并叠加背景、对齐线与组变换层。
 *
 * @module components/canvas/CanvasContainer
 */

import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ReactFlow,
  ConnectionLineType,
  useReactFlow,
  type Connection,
  type IsValidConnection,
  type OnConnect,
  type OnMove,
  type Viewport as RFViewport,
} from '@xyflow/react';
import {
  Frame as FrameIcon,
  ImageIcon,
  Square,
  StickyNote,
  Type,
  Upload,
  Video,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '@/stores/canvas-store';
import { nodeBox, type CanvasFlowNode, type CanvasFlowEdge } from '@/lib/canvas/node-mapper';
import { computeAlignment } from '@/lib/canvas/alignment';
import { isSequenceable, wouldCreateSequenceCycle } from '@/lib/canvas/sequence';
import { isAnnotationSource } from '@/lib/canvas/annotation';
import { ZOOM_MAX, ZOOM_MIN, SNAP_THRESHOLD, DEFAULT_VIEWPORT } from '@/lib/canvas/constants';
import {
  createCanvasNode,
  createMediaTargetWithPanelNodes,
  type FlowPoint,
} from '@/lib/canvas/media-workflow';
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
  /** 在指定画布坐标上传媒体。 */
  onUploadMediaAt?: (position: FlowPoint) => void;
}

/** 找出与媒体目标成整体拖拽的媒体对话面板，或面板绑定的目标媒体。 */
function mediaPanelCompanionIds(nodes: CanvasFlowNode[], node: CanvasFlowNode): string[] {
  if (
    node.data.type === 'image' ||
    node.data.type === 'video' ||
    node.data.type === 'generation_placeholder'
  ) {
    return nodes
      .filter((n) => n.data.type === 'media_panel' && n.data.targetNodeId === node.id)
      .map((n) => n.id);
  }
  if (node.data.type === 'media_panel' && node.data.targetNodeId) {
    return [node.data.targetNodeId];
  }
  return [];
}

/** 取节点所属的主媒体候选组；非候选返回 null。 */
function candidateParentId(node: CanvasFlowNode): string | null {
  if (node.data.type === 'image' || node.data.type === 'video') {
    return node.data.candidateOf;
  }
  if (node.data.type === 'generation_placeholder') {
    return node.data.resultMode === 'candidate_for_target' ? (node.data.targetNodeId ?? null) : null;
  }
  return null;
}

/**
 * 画布容器。须置于 ReactFlowProvider 内。
 */
export function CanvasContainer({ initialViewport, onUploadMediaAt }: CanvasContainerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const reactFlow = useReactFlow<CanvasFlowNode, CanvasFlowEdge>();
  // 联动拖拽：记录被拖节点上一帧位置，用于把同组成员或媒体对话面板按相同位移跟随
  const groupDragRef = useRef<{ x: number; y: number } | null>(null);
  const { t } = useTranslation();
  const [createMenu, setCreateMenu] = useState<{
    screenX: number;
    screenY: number;
    flow: FlowPoint;
  } | null>(null);

  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const activeTool = useCanvasStore((s) => s.activeTool);
  const isEmpty = useCanvasStore((s) => s.nodes.length === 0);

  const hiddenCandidateNodeIds = useMemo(() => {
    const collapsedRootIds = new Set<string>();
    const childIdsByParentId = new Map<string, string[]>();

    for (const node of nodes) {
      if (
        (node.data.type === 'image' || node.data.type === 'video') &&
        node.data.candidatesCollapsed
      ) {
        collapsedRootIds.add(node.id);
      }

      const parentId = candidateParentId(node);
      if (parentId) {
        const childIds = childIdsByParentId.get(parentId) ?? [];
        childIds.push(node.id);
        childIdsByParentId.set(parentId, childIds);
      }
    }

    const hiddenIds = new Set<string>();
    const stack = Array.from(collapsedRootIds);
    const visitedParentIds = new Set<string>();

    while (stack.length > 0) {
      const parentId = stack.pop();
      if (!parentId || visitedParentIds.has(parentId)) continue;
      visitedParentIds.add(parentId);

      for (const childId of childIdsByParentId.get(parentId) ?? []) {
        if (hiddenIds.has(childId)) continue;
        hiddenIds.add(childId);
        stack.push(childId);
      }
    }

    return hiddenIds;
  }, [nodes]);

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const hidden =
          hiddenCandidateNodeIds.has(node.id) ||
          (node.data.type === 'media_panel' && hiddenCandidateNodeIds.has(node.data.targetNodeId));
        return hidden
          ? { ...node, hidden: true }
          : node;
      }),
    [hiddenCandidateNodeIds, nodes],
  );

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) =>
        hiddenCandidateNodeIds.has(edge.source) || hiddenCandidateNodeIds.has(edge.target)
          ? { ...edge, hidden: true }
          : edge,
      ),
    [hiddenCandidateNodeIds, edges],
  );

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

  // 拖动开始：若拖的是组内节点或媒体目标 / 媒体面板，记录起始位置以便联动
  const onNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, node: CanvasFlowNode) => {
    const hasMediaCompanion =
      mediaPanelCompanionIds(useCanvasStore.getState().nodes, node).length > 0;
    groupDragRef.current =
      node.data.groupId || hasMediaCompanion ? { x: node.position.x, y: node.position.y } : null;
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
          const movedIds = new Set<string>();
          for (const m of store.nodes) {
            if (m.id !== node.id && m.data.groupId === gid && !draggedIds.has(m.id)) {
              store.updateNode(m.id, {
                position: { x: m.position.x + dx, y: m.position.y + dy },
              });
              movedIds.add(m.id);
            }
          }
          for (const id of mediaPanelCompanionIds(store.nodes, node)) {
            const m = store.nodes.find((item) => item.id === id);
            if (!m || m.id === node.id || draggedIds.has(m.id) || movedIds.has(m.id)) continue;
            store.updateNode(m.id, {
              position: { x: m.position.x + dx, y: m.position.y + dy },
            });
          }
          groupDragRef.current = { x: node.position.x, y: node.position.y };
        }
      } else if (last) {
        const dx = node.position.x - last.x;
        const dy = node.position.y - last.y;
        if (dx !== 0 || dy !== 0) {
          const draggedIds = new Set(draggedNodes.map((n) => n.id));
          const store = useCanvasStore.getState();
          for (const id of mediaPanelCompanionIds(store.nodes, node)) {
            const m = store.nodes.find((item) => item.id === id);
            if (!m || m.id === node.id || draggedIds.has(m.id)) continue;
            store.updateNode(m.id, {
              position: { x: m.position.x + dx, y: m.position.y + dy },
            });
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
        const dx = result.x - node.position.x;
        const dy = result.y - node.position.y;
        updateNode(node.id, { position: { x: result.x, y: result.y } });
        if (dx !== 0 || dy !== 0) {
          const store = useCanvasStore.getState();
          for (const id of mediaPanelCompanionIds(store.nodes, node)) {
            const m = store.nodes.find((item) => item.id === id);
            if (!m || m.id === node.id) continue;
            store.updateNode(m.id, {
              position: { x: m.position.x + dx, y: m.position.y + dy },
            });
          }
        }
      }
      setGuides([]);
    },
    [setGuides, updateNode],
  );

  const onPaneClick = useCallback(() => {
    setCreateMenu(null);
    clearSelection();
    setEditingNode(null);
  }, [clearSelection, setEditingNode]);

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent<Element, globalThis.MouseEvent>) => {
      event.preventDefault();
      const rect = wrapperRef.current?.getBoundingClientRect();
      const flow = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setCreateMenu({
        screenX: rect ? event.clientX - rect.left : event.clientX,
        screenY: rect ? event.clientY - rect.top : event.clientY,
        flow,
      });
    },
    [reactFlow],
  );

  const createNodeAtMenu = useCallback(
    (kind: 'image' | 'video' | 'text' | 'note' | 'frame' | 'shape' | 'upload') => {
      if (!createMenu) return;
      setCreateMenu(null);

      if (kind === 'upload') {
        onUploadMediaAt?.(createMenu.flow);
        return;
      }

      const store = useCanvasStore.getState();
      const zIndex = Math.max(0, ...store.nodes.map((n) => n.zIndex ?? 0)) + 1;

      if (kind === 'image' || kind === 'video') {
        const { target, panel } = createMediaTargetWithPanelNodes({
          modality: kind,
          position: createMenu.flow,
          zIndex,
        });
        store.addNodes([target, panel], { select: false });
        store.setSelection([target.id]);
        return;
      }

      if (kind === 'note') {
        const note = createCanvasNode('text', createMenu.flow, {
          zIndex,
          data: {
            text: '',
            fontSize: 14,
            backgroundColor: 'hsl(48 95% 90%)',
          },
        });
        store.addNode(note, { select: true });
        store.setEditingNode(note.id);
        return;
      }

      const node = createCanvasNode(kind, createMenu.flow, { zIndex });
      store.addNode(node, { select: true });
      if (kind === 'text') store.setEditingNode(node.id);
    },
    [createMenu, onUploadMediaAt],
  );

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
    <div ref={wrapperRef} className="relative size-full" data-tool={activeTool}>
      <ReactFlow<CanvasFlowNode, CanvasFlowEdge>
        nodes={renderedNodes}
        edges={renderedEdges}
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
        onPaneContextMenu={onPaneContextMenu}
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

      {createMenu ? (
        <div
          className="glass absolute z-50 w-44 overflow-hidden rounded-xl border border-border p-1 shadow-soft"
          style={{ left: createMenu.screenX, top: createMenu.screenY }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {[
            { key: 'image', label: '添加图片节点', icon: ImageIcon },
            { key: 'video', label: '添加视频节点', icon: Video },
            { key: 'text', label: '文本', icon: Type },
            { key: 'note', label: '便签描述', icon: StickyNote },
            { key: 'frame', label: '画板', icon: FrameIcon },
            { key: 'shape', label: '形状', icon: Square },
            { key: 'upload', label: '上传媒体', icon: Upload },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-foreground hover:bg-muted"
              onClick={() =>
                createNodeAtMenu(
                  key as 'image' | 'video' | 'text' | 'note' | 'frame' | 'shape' | 'upload',
                )
              }
            >
              <Icon className="size-4 text-muted-foreground" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      ) : null}

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
