import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasHistory } from '@/components/canvas/use-canvas-history';
import { useCanvasStore } from '@/stores/canvas-store';
import { canvasNodeRow } from '../fixtures';

describe('差异式撤销/重做', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCanvasStore.getState().reset();
    useCanvasStore.getState().hydrate({
      projectId: 'project-1',
      nodeRows: [canvasNodeRow('a'), canvasNodeRow('b')],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('显式拖拽事务把多次批量更新合并成一次 undo/redo', () => {
    const { result, unmount } = renderHook(() => useCanvasHistory('project-1'));
    act(() => {
      useCanvasStore.getState().beginHistoryTransaction('拖动画布元素');
      useCanvasStore.getState().updateNodesBatch([
        { id: 'a', patch: { position: { x: 10, y: 20 } } },
        { id: 'b', patch: { position: { x: 30, y: 40 } } },
      ]);
      useCanvasStore.getState().updateNodesBatch([
        { id: 'a', patch: { position: { x: 100, y: 200 } } },
        { id: 'b', patch: { position: { x: 300, y: 400 } } },
      ]);
      useCanvasStore.getState().endHistoryTransaction();
    });

    act(() => result.current.undo());
    expect(useCanvasStore.getState().nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    act(() => result.current.redo());
    expect(useCanvasStore.getState().nodes.map((node) => node.position)).toEqual([
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ]);
    unmount();
  });

  it('连续文本修改在 400ms 窗口内合并，运行时 URL 变化不进入历史', () => {
    const { result, unmount } = renderHook(() => useCanvasHistory('project-1'));
    act(() => {
      useCanvasStore.getState().updateNodeData('a', { text: 'A' });
      useCanvasStore.getState().updateNodeData('a', { text: 'AB' });
      vi.advanceTimersByTime(401);
      useCanvasStore.getState().setNodeRuntime('a', { statusLabel: 'runtime' });
    });
    act(() => result.current.undo());
    const node = useCanvasStore.getState().nodes.find((item) => item.id === 'a');
    expect(node?.data).not.toHaveProperty('text', 'AB');
    act(() => result.current.redo());
    expect(useCanvasStore.getState().nodes.find((item) => item.id === 'a')?.data).toHaveProperty(
      'text',
      'AB',
    );
    unmount();
  });
});
