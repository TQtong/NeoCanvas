import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSubscriptionHandlers } from '@/types';
import { useRealtimeProject } from '@/lib/hooks/use-realtime-project';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';
import { canvasNodeRow, conversationRow } from '../fixtures';

const realtimeMocks = vi.hoisted(() => ({
  handlers: null as ProjectSubscriptionHandlers | null,
  unsubscribe: vi.fn(),
  snapshot: vi.fn(),
  getSession: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  getBrowserSupabase: () => ({
    auth: { getSession: realtimeMocks.getSession },
    realtime: { setAuth: realtimeMocks.setAuth },
  }),
}));

vi.mock('@/lib/realtime/project-channel', () => ({
  subscribeProject: (
    _client: unknown,
    _options: unknown,
    handlers: ProjectSubscriptionHandlers,
  ) => {
    realtimeMocks.handlers = handlers;
    return realtimeMocks.unsubscribe;
  },
}));

vi.mock('@/lib/realtime/reconcile-project', () => ({
  loadRealtimeProjectSnapshot: realtimeMocks.snapshot,
}));

describe('Realtime 项目连接与快照校正状态机', () => {
  beforeEach(() => {
    realtimeMocks.handlers = null;
    realtimeMocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'session-token' } },
      error: null,
    });
    realtimeMocks.setAuth.mockResolvedValue(undefined);
    realtimeMocks.snapshot.mockResolvedValue({
      viewport: { x: 10, y: 20, zoom: 0.8 },
      nodes: [],
      edges: [],
      conversations: [conversationRow('conversation-1')],
      messages: [],
      generations: [],
      hasMoreMessages: false,
    });
    useCanvasStore.getState().reset();
    useCanvasStore.getState().hydrate({
      projectId: 'project-1',
      nodeRows: [],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    useChatStore.getState().reset();
    useChatStore.getState().hydrateProjectChat({
      projectId: 'project-1',
      conversations: [conversationRow('conversation-1')],
      conversationId: 'conversation-1',
      messages: [],
      generations: [],
      selectedModelKey: null,
      agentMode: 'generate',
      hasMoreMessages: false,
    });
  });

  it('订阅成功后先校正快照再 connected，离线与在线按状态恢复', async () => {
    const { result, unmount } = renderHook(() => useRealtimeProject('project-1', 'conversation-1'));
    expect(result.current).toBe('connecting');
    await waitFor(() => expect(realtimeMocks.handlers).not.toBeNull());

    act(() => realtimeMocks.handlers?.onStatusChange?.('subscribed'));
    await waitFor(() => expect(result.current).toBe('connected'));
    expect(realtimeMocks.snapshot).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().viewport).toEqual({ x: 10, y: 20, zoom: 0.8 });

    act(() => window.dispatchEvent(new Event('offline')));
    expect(result.current).toBe('disconnected');
    expect(realtimeMocks.unsubscribe).toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(result.current).toBe('reconnecting'));
    unmount();
  });

  it('快照读取期间缓存 Realtime 事件并在校正后重放', async () => {
    const staleSnapshot = {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
      conversations: [conversationRow('conversation-1')],
      messages: [],
      generations: [],
      hasMoreMessages: false,
    };
    let releaseSnapshot: ((snapshot: typeof staleSnapshot) => void) | null = null;
    realtimeMocks.snapshot.mockImplementationOnce(
      () =>
        new Promise<typeof staleSnapshot>((resolve) => {
          releaseSnapshot = resolve;
        }),
    );

    const { result, unmount } = renderHook(() => useRealtimeProject('project-1', 'conversation-1'));
    await waitFor(() => expect(realtimeMocks.handlers).not.toBeNull());

    act(() => realtimeMocks.handlers?.onStatusChange?.('subscribed'));
    const remoteNode = canvasNodeRow('node-during-snapshot');
    act(() =>
      realtimeMocks.handlers?.onNodeChange?.({
        eventType: 'INSERT',
        table: 'canvas_nodes',
        new: remoteNode,
        old: {},
      }),
    );
    expect(useCanvasStore.getState().nodes).toHaveLength(0);

    await act(async () => {
      releaseSnapshot?.(staleSnapshot);
    });
    await waitFor(() => expect(result.current).toBe('connected'));
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual([
      'node-during-snapshot',
    ]);
    unmount();
  });
});
