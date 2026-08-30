'use client';

/** Flow Studio 三栏 DAG 编辑器。 */

import { useCallback, useMemo } from 'react';
import {
  Background,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import type {
  AssetRow,
  ModelCatalogEntry,
  WorkflowExecuteResponse,
  WorkflowNodeKind,
} from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { useWorkflowStore, useWorkflowStoreApi } from '@/components/flow/WorkflowProvider';
import { NodeLibrary } from '@/components/flow/NodeLibrary';
import { WorkflowNodeCard, type WorkflowFlowNode } from '@/components/flow/WorkflowNodeCard';
import { WorkflowInspector } from '@/components/flow/WorkflowInspector';
import { createWorkflowGraphNode, getWorkflowNodeDefinition } from '@/lib/workflow/registry';
import { useWorkflowSync } from '@/lib/hooks/use-workflow-sync';
import { invokeEdge } from '@/lib/edge/client';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/spinner';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { formatZoom } from '@/lib/utils/format';

const nodeTypes: NodeTypes = { workflow: WorkflowNodeCard };

/**
 * Flow 画布左下角的视口工具条。
 *
 * 使用产品自己的玻璃面板与图标按钮替代 React Flow 默认控件；缩放值直接订阅画布
 * transform，因此触控板和滚轮缩放也会实时反映在百分比上。
 */
function FlowViewportControls() {
  const reactFlow = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);

  return (
    <Panel position="bottom-left" className="!m-4">
      <div className="flex items-center gap-0.5 rounded-xl border border-border/80 bg-card/90 p-1 shadow-float backdrop-blur-xl">
        <Tooltip content="缩小画布">
          <IconButton
            size="sm"
            label="缩小画布"
            disabled={zoom <= 0.15}
            onClick={() => void reactFlow.zoomOut({ duration: 180 })}
          >
            <Minus />
          </IconButton>
        </Tooltip>

        <span
          className="w-12 select-none text-center text-[11px] font-medium tabular-nums text-muted-foreground"
          aria-label={`当前缩放比例 ${formatZoom(zoom)}`}
        >
          {formatZoom(zoom)}
        </span>

        <Tooltip content="放大画布">
          <IconButton
            size="sm"
            label="放大画布"
            disabled={zoom >= 2}
            onClick={() => void reactFlow.zoomIn({ duration: 180 })}
          >
            <Plus />
          </IconButton>
        </Tooltip>

        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

        <Tooltip content="适应全部节点">
          <IconButton
            size="sm"
            label="适应全部节点"
            onClick={() => void reactFlow.fitView({ padding: 0.18, duration: 280 })}
          >
            <Maximize2 />
          </IconButton>
        </Tooltip>
      </div>
    </Panel>
  );
}

export interface FlowEditorProps {
  projectId: string;
  workflowId: string;
  workflowName: string;
  models: ModelCatalogEntry[];
  assets: AssetRow[];
}

export function FlowEditor(props: FlowEditorProps) {
  const toast = useToast();
  const store = useWorkflowStoreApi();
  const sync = useWorkflowSync(props.workflowId);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const problems = useWorkflowStore((state) => state.problems);
  const staleNodeIds = useWorkflowStore((state) => state.staleNodeIds);
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
  const graphRevision = useWorkflowStore((state) => state.graphRevision);
  const runNodes = useWorkflowStore((state) => state.runNodes);
  const activeRunId = useWorkflowStore((state) => state.activeRunId);
  const syncStatus = useWorkflowStore((state) => state.syncStatus);
  const syncError = useWorkflowStore((state) => state.syncError);
  const setSelection = useWorkflowStore((state) => state.setSelection);
  const addNode = useWorkflowStore((state) => state.addNode);
  const updateNodePosition = useWorkflowStore((state) => state.updateNodePosition);
  const removeNode = useWorkflowStore((state) => state.removeNode);
  const addEdge = useWorkflowStore((state) => state.addEdge);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const setActiveRun = useWorkflowStore((state) => state.setActiveRun);

  const statusByNodeId = useMemo(
    () =>
      new Map(
        runNodes
          .filter((node) => node.run_id === activeRunId)
          .map((node) => [node.workflow_node_id, node.status]),
      ),
    [activeRunId, runNodes],
  );

  const flowNodes = useMemo<WorkflowFlowNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: 'workflow',
        position: node.position,
        selected: node.id === selectedNodeId,
        data: {
          graphNode: node,
          status: statusByNodeId.get(node.id),
          stale: staleNodeIds.has(node.id),
          problemCount: problems.filter((problem) => problem.nodeId === node.id).length,
        },
      })),
    [nodes, problems, selectedNodeId, staleNodeIds, statusByNodeId],
  );

  const flowEdges = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        label: edge.valueType,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 1.5 },
        labelStyle: { fontSize: 9 },
      })),
    [edges],
  );

  const handleAdd = useCallback(
    (kind: WorkflowNodeKind) => {
      const index = nodes.length;
      addNode(
        createWorkflowGraphNode(kind, {
          x: 80 + (index % 4) * 280,
          y: 80 + Math.floor(index / 4) * 180,
        }),
      );
    },
    [addNode, nodes.length],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          updateNodePosition(change.id, change.position);
        } else if (change.type === 'remove') {
          removeNode(change.id);
        } else if (change.type === 'select' && change.selected) {
          setSelection(change.id);
        }
      }
    },
    [removeNode, setSelection, updateNodePosition],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) if (change.type === 'remove') removeEdge(change.id);
    },
    [removeEdge],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle ||
        !connection.targetHandle
      )
        return;
      const source = nodes.find((node) => node.id === connection.source);
      const target = nodes.find((node) => node.id === connection.target);
      if (!source || !target) return;
      const sourcePort = getWorkflowNodeDefinition(source.kind).outputs.find(
        (port) => port.id === connection.sourceHandle,
      );
      const targetPort = getWorkflowNodeDefinition(target.kind).inputs.find(
        (port) => port.id === connection.targetHandle,
      );
      if (!sourcePort || !targetPort || sourcePort.valueType !== targetPort.valueType) {
        toast.error('只能连接相同类型的端口');
        return;
      }
      const accepted = addEdge({
        id: crypto.randomUUID(),
        sourceNodeId: source.id,
        sourcePort: sourcePort.id,
        targetNodeId: target.id,
        targetPort: targetPort.id,
        valueType: sourcePort.valueType,
      });
      if (!accepted) toast.error('连接会造成重复输入或环路');
    },
    [addEdge, nodes, toast],
  );

  const run = useCallback(
    async (mode: 'node' | 'downstream' | 'all', targetNodeId?: string, force = false) => {
      await sync.flush();
      const stateProblems = problems;
      if (stateProblems.length > 0) {
        toast.error(`请先修复 ${stateProblems.length} 个图校验问题`);
        return;
      }
      try {
        const result = await invokeEdge<Record<string, unknown>, WorkflowExecuteResponse>(
          EDGE_FUNCTIONS.workflowExecute,
          {
            action: 'start',
            projectId: props.projectId,
            workflowId: props.workflowId,
            expectedGraphRevision: store.getState().graphRevision,
            idempotencyKey: crypto.randomUUID(),
            runMode: mode,
            targetNodeId,
            force,
          },
        );
        setActiveRun(result.runId);
        await sync.refreshRuns();
        toast.success(force ? '已开始强制重跑' : '工作流已开始运行');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '运行失败');
      }
    },
    [problems, props.projectId, props.workflowId, setActiveRun, store, sync, toast],
  );

  const refreshAll = useCallback(async () => {
    await sync.flush();
    await Promise.all([sync.refreshGraph(), sync.refreshRuns()]);
  }, [sync]);

  if (!sync.ready) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner label="加载工作流" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <NodeLibrary onAdd={handleAdd} />
      <main className="relative min-w-0 flex-1 bg-background">
        <ReactFlow<WorkflowFlowNode>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneClick={() => setSelection(null)}
          fitView
          minZoom={0.15}
          maxZoom={2}
          deleteKeyCode={['Backspace', 'Delete']}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <FlowViewportControls />
        </ReactFlow>
        <div className="pointer-events-none absolute right-3 top-3 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-soft backdrop-blur">
          revision {graphRevision} · {syncStatus}
          {syncError ? ` · ${syncError}` : ''}
        </div>
        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-2xl border border-dashed border-border bg-card/80 px-8 py-6 text-center shadow-soft">
              <p className="text-sm font-medium text-foreground">从左侧加入第一个节点</p>
              <p className="mt-1 text-xs text-muted-foreground">
                编辑不会自动调用模型，运行始终由你触发。
              </p>
            </div>
          </div>
        ) : null}
      </main>
      <WorkflowInspector {...props} onRun={run} onRefresh={refreshAll} />
    </div>
  );
}
