import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@/types';
import { useImageEditSession } from '@/components/canvas/image-editing/use-image-edit-session';

const model: ModelCatalogEntry = {
  key: 'precision-model',
  displayName: 'Precision Model',
  provider: 'openai',
  modality: 'image',
  capabilities: {
    imageOperations: ['semantic_edit', 'inpaint', 'outpaint', 'remove_background', 'upscale'],
    aspectRatios: ['1:1', '16:9'],
    sizes: [],
    maxOutputs: 4,
    supportsNegativePrompt: false,
    supportsReferenceImages: true,
    supportsImageToVideo: false,
    supportsSeed: false,
    qualities: ['auto'],
    isAsync: false,
    supportsWebhook: false,
    inputFidelityOptions: ['standard', 'high'],
    upscaleFactors: [2, 4],
  },
  defaultParams: {},
  sortOrder: 1,
  isActive: true,
  userId: null,
};

describe('精准编辑局部会话', () => {
  it('五类操作共用会话但强制单结果操作的候选数量', () => {
    const { result } = renderHook(() =>
      useImageEditSession({ sourceWidth: 1200, sourceHeight: 800, initialModel: model }),
    );
    act(() => result.current.dispatch({ type: 'count', value: 4, max: 4 }));
    expect(result.current.state.count).toBe(4);
    act(() =>
      result.current.dispatch({ type: 'operation', operation: 'remove_background', model }),
    );
    expect(result.current.state.count).toBe(1);
    act(() => result.current.dispatch({ type: 'operation', operation: 'upscale', model }));
    expect(result.current.state.count).toBe(1);
  });

  it('蒙版历史、清空、撤销和重做完全局部化', () => {
    const { result } = renderHook(() =>
      useImageEditSession({ sourceWidth: 600, sourceHeight: 400, initialModel: model }),
    );
    act(() => {
      result.current.dispatch({ type: 'operation', operation: 'inpaint', model });
      result.current.dispatch({
        type: 'mask-stroke',
        stroke: {
          id: 'stroke-1',
          tool: 'brush',
          sizePx: 30,
          points: [{ x: 30, y: 40, pressure: 1 }],
        },
      });
    });
    expect(result.current.canUndoMask).toBe(true);
    act(() => result.current.dispatch({ type: 'mask-clear' }));
    expect(result.current.state.maskHistory.cursor).toBe(2);
    act(() => result.current.dispatch({ type: 'mask-undo' }));
    expect(result.current.canRedoMask).toBe(true);
    act(() => result.current.dispatch({ type: 'mask-redo' }));
    expect(result.current.state.maskHistory.cursor).toBe(2);
  });

  it('切换输入像素会重置旧蒙版与扩图边界，比例预设保持中心', () => {
    const { result } = renderHook(() =>
      useImageEditSession({ sourceWidth: 1200, sourceHeight: 800, initialModel: model }),
    );
    act(() =>
      result.current.dispatch({
        type: 'outpaint-insets',
        value: { top: 10, right: 20, bottom: 30, left: 40 },
      }),
    );
    act(() => result.current.dispatch({ type: 'source-dimensions', width: 900, height: 900 }));
    expect(result.current.state.outputCanvas).toEqual({
      width: 900,
      height: 900,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 900,
      sourceHeight: 900,
    });
    act(() =>
      result.current.dispatch({
        type: 'outpaint-preset',
        value: '16:9',
        sourceWidth: 900,
        sourceHeight: 900,
      }),
    );
    expect(result.current.state.outputCanvas.width / result.current.state.outputCanvas.height).toBe(
      16 / 9,
    );
    expect(result.current.isDirty).toBe(true);
  });
});
