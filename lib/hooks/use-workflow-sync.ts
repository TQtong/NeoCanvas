'use client';

/** Flow 图持久化、Outbox 重放与 Realtime 回流。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WorkflowEdgeRow,
  WorkflowNodeRow,
  WorkflowRunNodeRow,
  WorkflowRunOutputRow,
  WorkflowRunRow,
} from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import {
  deleteWorkflowOutbox,
  putWorkflowOutbox,
  readWorkflowOutbox,
  type WorkflowMutationBatch,
} from '@/lib/workflow/outbox';
import { useWorkflowStoreApi } from '@/components/flow/WorkflowProvider';

const SAVE_DELAY = 300;

async function persistBatch(batch: WorkflowMutationBatch): Promise<number> {
  const supabase = getBrowserSupabase();
  if (batch.deletedEdgeIds.length > 0) {
    const { error } = await supabase
      .from('workflow_edges')
      .delete()
      .eq('workflow_id', batch.workflowId)
      .in('id', batch.deletedEdgeIds);
    if (error) throw error;
  }
  if (batch.deletedNodeIds.length > 0) {
    const { error } = await supabase
      .from('workflow_nodes')
      .delete()
      .eq('workflow_id', batch.workflowId)
      .in('id', batch.deletedNodeIds);
    if (error) throw error;
  }
  if (batch.nodes.length > 0) {
    const { error } = await supabase.from('workflow_nodes').upsert(
      batch.nodes.map((node) => ({
        id: node.id,
        workflow_id: batch.workflowId,
        kind: node.kind,
        position_x: node.position.x,
        position_y: node.position.y,
        config: node.config,
        schema_version: node.schemaVersion,
      })),
    );
    if (error) throw error;
  }
  if (batch.edges.length > 0) {
    const { error } = await supabase.from('workflow_edges').upsert(
      batch.edges.map((edge) => ({
        id: edge.id,
        workflow_id: batch.workflowId,
        source_node_id: edge.sourceNodeId,
        source_port: edge.sourcePort,
        target_node_id: edge.targetNodeId,
        target_port: edge.targetPort,
        value_type: edge.valueType,
      })),
    );
    if (error) throw error;
  }
  const { data, error } = await supabase
    .from('workflows')
    .select('graph_revision')
    .eq('id', batch.workflowId)
    .single();
  if (error) throw error;
  return data.graph_revision;
}

export interface WorkflowSyncController {
  ready: boolean;
  refreshGraph: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  flush: () => Promise<void>;
}

/** 建立工作流专属同步控制器。 */
export function useWorkflowSync(workflowId: string): WorkflowSyncController {
  const store = useWorkflowStoreApi();
  const [ready, setReady] = useState(false);
  const timerRef = useRef<number | null>(null);
  const flushingRef = useRef<Promise<void> | null>(null);

  const refreshGraph = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const [{ data: workflow }, { data: nodes }, { data: edges }] = await Promise.all([
      supabase.from('workflows').select('*').eq('id', workflowId).single(),
      supabase.from('workflow_nodes').select('*').eq('workflow_id', workflowId),
      supabase.from('workflow_edges').select('*').eq('workflow_id', workflowId),
    ]);
    if (!workflow) return;
    store
      .getState()
      .hydrateGraph(
        workflow.graph_revision,
        (nodes ?? []) as WorkflowNodeRow[],
        (edges ?? []) as WorkflowEdgeRow[],
      );
  }, [store, workflowId]);

  const refreshRuns = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const { data: runs } = await supabase
      .from('workflow_runs')
      .select('*')
      .eq('workflow_id', workflowId)
      .order('created_at', { ascending: false })
      .limit(20);
    const runRows = (runs ?? []) as WorkflowRunRow[];
    const runIds = runRows.map((run) => run.id);
    const { data: runNodes } =
      runIds.length > 0
        ? await supabase.from('workflow_run_nodes').select('*').in('run_id', runIds)
        : { data: [] };
    const nodeRows = (runNodes ?? []) as WorkflowRunNodeRow[];
    const nodeIds = nodeRows.map((node) => node.id);
    const { data: outputs } =
      nodeIds.length > 0
        ? await supabase.from('workflow_run_outputs').select('*').in('run_node_id', nodeIds)
        : { data: [] };
    store.getState().hydrateRuns(runRows, nodeRows, (outputs ?? []) as WorkflowRunOutputRow[]);
  }, [store, workflowId]);

  const flush = useCallback(async () => {
    if (flushingRef.current) return flushingRef.current;
    const task = (async () => {
      const state = store.getState();
      const nodeIds = new Set(state.dirtyNodeIds);
      const edgeIds = new Set(state.dirtyEdgeIds);
      if (
        nodeIds.size === 0 &&
        edgeIds.size === 0 &&
        state.deletedNodeIds.size === 0 &&
        state.deletedEdgeIds.size === 0
      )
        return;
      const epoch = state.changeEpoch;
      const batch: WorkflowMutationBatch = {
        workflowId,
        nodes: state.nodes.filter((node) => nodeIds.has(node.id)),
        edges: state.edges.filter((edge) => edgeIds.has(edge.id)),
        deletedNodeIds: [...state.deletedNodeIds],
        deletedEdgeIds: [...state.deletedEdgeIds],
        queuedAt: new Date().toISOString(),
      };
      store.getState().markSaving();
      try {
        const revision = await persistBatch(batch);
        await deleteWorkflowOutbox(workflowId);
        store.getState().clearDirty(epoch, revision);
      } catch (error) {
        await putWorkflowOutbox(batch).catch(() => undefined);
        store
          .getState()
          .markSyncFailure(
            error instanceof Error ? error.message : '工作流保存失败',
            typeof navigator !== 'undefined' && !navigator.onLine,
          );
      }
    })().finally(() => {
      flushingRef.current = null;
    });
    flushingRef.current = task;
    return task;
  }, [store, workflowId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const queued = await readWorkflowOutbox(workflowId).catch(() => null);
      if (queued && navigator.onLine) {
        await persistBatch(queued)
          .then(() => deleteWorkflowOutbox(workflowId))
          .catch(() => undefined);
      }
      await refreshGraph();
      if (cancelled) return;
      await refreshRuns();
      if (!cancelled) setReady(true);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshGraph, refreshRuns, store, workflowId]);

  useEffect(() => {
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.changeEpoch === previous.changeEpoch) return;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), SAVE_DELAY);
    });
    const handleOnline = () => void flush();
    window.addEventListener('online', handleOnline);
    return () => {
      unsubscribe();
      window.removeEventListener('online', handleOnline);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      void flush();
    };
  }, [flush, store]);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    let runRefreshTimer: number | null = null;
    const scheduleRunRefresh = () => {
      if (runRefreshTimer !== null) window.clearTimeout(runRefreshTimer);
      runRefreshTimer = window.setTimeout(() => void refreshRuns(), 80);
    };
    const channel = supabase
      .channel(`workflow:${workflowId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workflows',
          filter: `id=eq.${workflowId}`,
        },
        (payload) => {
          const row = payload.new as { graph_revision?: number };
          if (typeof row.graph_revision === 'number') {
            store.getState().reconcileWorkflowRevision(row.graph_revision);
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workflow_nodes',
          filter: `workflow_id=eq.${workflowId}`,
        },
        (payload) => {
          store
            .getState()
            .reconcileNode(
              payload.eventType === 'DELETE' ? null : (payload.new as WorkflowNodeRow),
              (payload.old as { id?: string }).id,
            );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workflow_edges',
          filter: `workflow_id=eq.${workflowId}`,
        },
        (payload) => {
          store
            .getState()
            .reconcileEdge(
              payload.eventType === 'DELETE' ? null : (payload.new as WorkflowEdgeRow),
              (payload.old as { id?: string }).id,
            );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workflow_runs',
          filter: `workflow_id=eq.${workflowId}`,
        },
        scheduleRunRefresh,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workflow_run_nodes',
        },
        (payload) => {
          const runId =
            (payload.new as { run_id?: string }).run_id ??
            (payload.old as { run_id?: string }).run_id;
          if (runId && store.getState().runs.some((run) => run.id === runId)) scheduleRunRefresh();
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'workflow_run_outputs',
        },
        scheduleRunRefresh,
      )
      .subscribe();
    return () => {
      if (runRefreshTimer !== null) window.clearTimeout(runRefreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [refreshRuns, store, workflowId]);

  return { ready, refreshGraph, refreshRuns, flush };
}
