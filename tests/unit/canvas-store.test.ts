import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvas-store';
import { canvasNode, canvasNodeRow, generationRow } from '../fixtures';

describe('CanvasStore 可靠性与批量更新', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset();
    useCanvasStore.getState().hydrate({
      projectId: 'project-1',
      nodeRows: [canvasNodeRow('a'), canvasNodeRow('b', 'image', { asset_id: 'asset-1' })],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('50 节点批量移动只触发一次 Store 更新并一次性标脏', () => {
    const extraRows = Array.from({ length: 48 }, (_, index) => canvasNodeRow(`n-${index}`));
    useCanvasStore.getState().hydrate({
      projectId: 'project-1',
      nodeRows: [canvasNodeRow('a'), canvasNodeRow('b'), ...extraRows],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    let notifications = 0;
    const unsubscribe = useCanvasStore.subscribe(() => {
      notifications += 1;
    });
    useCanvasStore.getState().updateNodesBatch(
      useCanvasStore.getState().nodes.map((node, index) => ({
        id: node.id,
        patch: { position: { x: index * 10, y: index * -5 } },
      })),
    );
    unsubscribe();

    expect(notifications).toBe(1);
    expect(useCanvasStore.getState()._dirtyNodeIds.size).toBe(50);
    expect(useCanvasStore.getState().nodes[49]?.position).toEqual({ x: 490, y: -245 });
  });

  it('flush 失败后把 upsert 精确放回脏集，下一轮不会丢写', () => {
    useCanvasStore.getState().updateNode('a', { position: { x: 80, y: 40 } });
    const first = useCanvasStore.getState().flushDirty();
    expect(first.upserts.map((node) => node.id)).toEqual(['a']);
    expect(useCanvasStore.getState()._pendingNodeIds.has('a')).toBe(true);

    useCanvasStore.getState().markPersistFailed(['a']);
    expect(useCanvasStore.getState()._dirtyNodeIds.has('a')).toBe(true);
    const retry = useCanvasStore.getState().flushDirty();
    expect(retry.upserts[0]?.position).toEqual({ x: 80, y: 40 });
  });

  it('Realtime 校正不会覆盖本地脏节点，确认后更新版本才可接收新远端值', () => {
    useCanvasStore.getState().updateNode('a', { position: { x: 50, y: 60 } });
    useCanvasStore.getState().applyRemoteNode({
      eventType: 'UPDATE',
      table: 'canvas_nodes',
      new: canvasNodeRow('a', 'shape', {
        position_x: 999,
        updated_at: '2026-08-25T09:00:00Z',
      }),
      old: {},
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'a')?.position.x).toBe(50);

    useCanvasStore.getState().flushDirty();
    useCanvasStore.getState().markNodePersisted('a', '2026-08-25T09:00:00Z');
    useCanvasStore.getState().applyRemoteNode({
      eventType: 'UPDATE',
      table: 'canvas_nodes',
      new: canvasNodeRow('a', 'shape', {
        position_x: 120,
        updated_at: '2026-08-25T09:00:01Z',
      }),
      old: {},
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'a')?.position.x).toBe(120);
  });

  it('运行时签名 URL 更新不会进入持久化脏集或媒体结构 revision', () => {
    const beforeRevision = useCanvasStore.getState()._mediaRevision;
    useCanvasStore.getState().setAssetRuntime('asset-1', {
      src: 'signed-v2',
      urlExpiresAt: '2026-08-25T10:00:00Z',
    });
    const state = useCanvasStore.getState();
    expect(state._dirtyNodeIds.size).toBe(0);
    expect(state._mediaRevision).toBe(beforeRevision);
    expect(state.nodes.find((node) => node.id === 'b')?.data).toMatchObject({ src: 'signed-v2' });
  });

  it('生成快照把快速失败终态投影到占位节点且不标脏', () => {
    useCanvasStore.getState().hydrate({
      projectId: 'project-1',
      nodeRows: [
        canvasNodeRow('placeholder-1', 'generation_placeholder', {
          generation_id: 'generation-1',
        }),
      ],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    useCanvasStore.getState().reconcileGenerationSnapshot([
      generationRow('generation-1', {
        placeholder_node_id: 'placeholder-1',
        status: 'failed',
        progress: 10,
        error: '永久拒绝',
        completed_at: '2026-08-25T08:00:01.000Z',
      }),
    ]);

    const state = useCanvasStore.getState();
    expect(state.nodes[0]?.data).toMatchObject({
      progress: 10,
      statusLabel: 'failed',
      errorMessage: '永久拒绝',
    });
    expect(state._dirtyNodeIds.size).toBe(0);
  });

  it('outbox 重放中删除优先，悬挂边不会复活', () => {
    useCanvasStore.getState().replayOutbox({
      nodeUpserts: [canvasNode('c')],
      nodeDeletes: ['a'],
      edgeUpserts: [{ id: 'edge-ac', source: 'a', target: 'c' }],
      edgeDeletes: [],
      viewport: { x: 10, y: 20, zoom: 0.75 },
    });
    const state = useCanvasStore.getState();
    expect(state.nodes.map((node) => node.id)).toEqual(['b', 'c']);
    expect(state.edges).toEqual([]);
    expect(state._deletedNodeIds.has('a')).toBe(true);
    expect(state._dirtyNodeIds.has('c')).toBe(true);
    expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 0.75 });
  });
});
