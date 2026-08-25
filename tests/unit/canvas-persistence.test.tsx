import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasPersistence } from '@/lib/hooks/use-canvas-persistence';
import { useCanvasStore } from '@/stores/canvas-store';
import { canvasNodeRow } from '../fixtures';

interface DeferredResult {
  promise: Promise<{ data: Array<{ id: string; updated_at: string }>; error: null }>;
  resolve: (value: { data: Array<{ id: string; updated_at: string }>; error: null }) => void;
}

/** 创建由测试显式释放的 PostgREST 响应。 */
function deferredResult(): DeferredResult {
  let resolve!: DeferredResult['resolve'];
  const promise = new Promise<{ data: Array<{ id: string; updated_at: string }>; error: null }>(
    (complete) => {
      resolve = complete;
    },
  );
  return { promise, resolve };
}

const persistenceMocks = vi.hoisted(() => ({
  upsertRows: vi.fn(),
  batches: [] as Array<Array<Record<string, unknown>>>,
  deferred: [] as DeferredResult[],
}));

vi.mock('@/lib/supabase/client', () => ({
  getBrowserSupabase: () => ({
    from: (table: string) => {
      if (table === 'canvas_nodes') {
        return {
          upsert: (rows: Array<Record<string, unknown>>) => {
            persistenceMocks.upsertRows(rows);
            persistenceMocks.batches.push(rows);
            const pending = deferredResult();
            persistenceMocks.deferred.push(pending);
            return { select: () => pending.promise };
          },
          delete: () => ({ in: async () => ({ error: null }) }),
        };
      }
      if (table === 'canvas_edges') {
        return {
          upsert: async () => ({ error: null }),
          delete: () => ({ in: async () => ({ error: null }) }),
        };
      }
      return {
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  }),
}));

vi.mock('@/lib/utils/debounce', () => ({
  debounce: (callback: () => void) => {
    const immediate = () => callback();
    immediate.cancel = vi.fn();
    immediate.flush = vi.fn();
    immediate.pending = () => false;
    return immediate;
  },
}));

describe('画布串行持久化控制器', () => {
  beforeEach(() => {
    persistenceMocks.batches.length = 0;
    persistenceMocks.deferred.length = 0;
    useCanvasStore.getState().reset();
    useCanvasStore.getState().hydrate({
      projectId: 'persistence-project',
      nodeRows: [canvasNodeRow('node-1', 'shape', { project_id: 'persistence-project' })],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  afterEach(() => {
    useCanvasStore.getState().reset();
  });

  it('首批未完成时绝不启动第二批，释放后立即提交最后 revision', async () => {
    const { result, unmount } = renderHook(() =>
      useCanvasPersistence('persistence-project', 'user-1'),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      useCanvasStore.getState().updateNode('node-1', { position: { x: 10, y: 20 } });
    });
    await waitFor(() => expect(persistenceMocks.batches).toHaveLength(1));

    act(() => {
      useCanvasStore.getState().updateNode('node-1', { position: { x: 90, y: 120 } });
    });
    expect(persistenceMocks.batches).toHaveLength(1);

    await act(async () => {
      persistenceMocks.deferred[0]!.resolve({
        data: [{ id: 'node-1', updated_at: '2026-08-25T10:00:00.000Z' }],
        error: null,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(persistenceMocks.batches).toHaveLength(2));
    expect(persistenceMocks.batches[0]?.[0]?.position_x).toBe(10);
    expect(persistenceMocks.batches[1]?.[0]?.position_x).toBe(90);
    expect(persistenceMocks.batches[1]?.[0]?.position_y).toBe(120);

    await act(async () => {
      persistenceMocks.deferred[1]!.resolve({
        data: [{ id: 'node-1', updated_at: '2026-08-25T10:00:01.000Z' }],
        error: null,
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      const syncState = useCanvasStore.getState().syncState;
      if (syncState.status !== 'saved') throw new Error(JSON.stringify(syncState));
    });
    unmount();
  });
});
