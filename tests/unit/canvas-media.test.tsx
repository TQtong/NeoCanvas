import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestCanvasAssetRefresh, useCanvasMedia } from '@/lib/hooks/use-canvas-media';
import { useCanvasStore } from '@/stores/canvas-store';
import { canvasNodeRow } from '../fixtures';

const mediaMocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  getBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ in: mediaMocks.query }),
      }),
    }),
  }),
}));

vi.mock('@/lib/storage/signed-url', () => ({
  resolveAssetViews: mediaMocks.resolve,
}));

describe('画布媒体签名 URL 续签', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset();
    useCanvasStore.getState().hydrate({
      projectId: 'project-1',
      nodeRows: [
        canvasNodeRow('image-a', 'image', { asset_id: 'asset-1' }),
        canvasNodeRow('image-b', 'image', { asset_id: 'asset-1', position_x: 400 }),
      ],
      edgeRows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    mediaMocks.query.mockResolvedValue({
      data: [
        {
          id: 'asset-1',
          project_id: 'project-1',
          storage_bucket: 'generations',
          storage_path: 'staging/user/generation/attempt/image.png',
        },
      ],
      error: null,
    });
    mediaMocks.resolve.mockImplementation(async () => [
      {
        id: 'asset-1',
        url: `signed-${mediaMocks.resolve.mock.calls.length}`,
        thumbnailUrl: null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      },
    ]);
  });

  afterEach(() => {
    useCanvasStore.getState().reset();
  });

  it('同一资产只请求一次并一次更新全部引用；并发强制续签保持 single-flight', async () => {
    const { unmount } = renderHook(() => useCanvasMedia('project-1'));
    await waitFor(() => expect(mediaMocks.query).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const sources = useCanvasStore
        .getState()
        .nodes.map((node) => (node.data.type === 'image' ? node.data.src : null));
      expect(sources).toEqual(['signed-1', 'signed-1']);
    });

    act(() => {
      requestCanvasAssetRefresh('asset-1');
      requestCanvasAssetRefresh('asset-1');
    });
    await waitFor(() => expect(mediaMocks.query).toHaveBeenCalledTimes(2));
    expect(mediaMocks.resolve).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      const sources = useCanvasStore
        .getState()
        .nodes.map((node) => (node.data.type === 'image' ? node.data.src : null));
      expect(sources).toEqual(['signed-2', 'signed-2']);
    });

    unmount();
    act(() => requestCanvasAssetRefresh('asset-1'));
    expect(mediaMocks.query).toHaveBeenCalledTimes(2);
  });
});
