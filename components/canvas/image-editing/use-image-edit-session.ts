'use client';

/**
 * 单次精准图片编辑的局部会话状态。
 *
 * 笔画、扩图边界与异步阶段只活在覆盖层生命周期内，不进入全局画布库。成功提交后由既有
 * generation / Realtime 流程接管；失败则保留本状态供用户修改或重试。
 *
 * @module components/canvas/image-editing/use-image-edit-session
 */

import { useCallback, useReducer } from 'react';
import type {
  AspectRatio,
  ImageInputFidelity,
  ImageInputMode,
  ImageOperation,
  ImageUpscaleFactor,
  ModelCatalogEntry,
  OutputCanvas,
} from '@/types';
import {
  appendMaskCommand,
  createMaskHistory,
  outputCanvasForAspectRatio,
  outputCanvasFromInsets,
  outputCanvasToInsets,
  redoMaskCommand,
  undoMaskCommand,
  type MaskHistory,
  type MaskStroke,
  type MaskTool,
  type OutpaintInsets,
} from '@/lib/canvas/image-editing';
import { uuid } from '@/lib/utils/id';

/** 编辑器异步状态机。 */
export type ImageEditStatus =
  | 'loading'
  | 'editing'
  | 'preparing'
  | 'uploading'
  | 'submitting'
  | 'waiting'
  | 'success'
  | 'failure'
  | 'cancelled';

/** 完整局部会话。 */
export interface ImageEditSessionState {
  status: ImageEditStatus;
  operation: Exclude<ImageOperation, 'generate'>;
  inputMode: ImageInputMode;
  inputFidelity: ImageInputFidelity | undefined;
  modelKey: string | null;
  prompt: string;
  count: number;
  maskTool: MaskTool;
  brushSizePx: number;
  maskFeatherPx: number;
  maskVisible: boolean;
  maskHistory: MaskHistory;
  outputCanvas: OutputCanvas;
  outpaintPreset: AspectRatio | 'free';
  upscaleFactor: ImageUpscaleFactor;
  error: string | null;
  revision: number;
}

type EditOperation = ImageEditSessionState['operation'];

type Action =
  | { type: 'status'; status: ImageEditStatus; error?: string | null }
  | { type: 'operation'; operation: EditOperation; model: ModelCatalogEntry | null }
  | { type: 'input-mode'; value: ImageInputMode }
  | { type: 'source-dimensions'; width: number; height: number }
  | { type: 'input-fidelity'; value: ImageInputFidelity | undefined }
  | { type: 'model'; model: ModelCatalogEntry | null }
  | { type: 'prompt'; value: string }
  | { type: 'count'; value: number; max: number }
  | { type: 'mask-tool'; value: MaskTool }
  | { type: 'brush-size'; value: number }
  | { type: 'mask-feather'; value: number }
  | { type: 'mask-visible'; value: boolean }
  | { type: 'mask-stroke'; stroke: MaskStroke }
  | { type: 'mask-clear' }
  | { type: 'mask-undo' }
  | { type: 'mask-redo' }
  | { type: 'mask-history'; history: MaskHistory }
  | { type: 'outpaint-preset'; value: AspectRatio; sourceWidth: number; sourceHeight: number }
  | { type: 'outpaint-insets'; value: OutpaintInsets }
  | { type: 'upscale'; value: ImageUpscaleFactor };

/** 依据模型能力校正模型相关参数。 */
function withModelConstraints(
  state: ImageEditSessionState,
  model: ModelCatalogEntry | null,
): ImageEditSessionState {
  if (!model) return { ...state, modelKey: null, count: 1, inputFidelity: undefined };
  const maxCount =
    state.operation === 'remove_background' || state.operation === 'upscale'
      ? 1
      : Math.min(4, model.capabilities.maxOutputs);
  const inputFidelity = state.inputFidelity;
  const supportedFidelity = model.capabilities.inputFidelityOptions ?? [];
  const upscaleFactors = model.capabilities.upscaleFactors ?? [];
  return {
    ...state,
    modelKey: model.key,
    count: Math.max(1, Math.min(state.count, maxCount)),
    inputFidelity:
      inputFidelity && supportedFidelity.includes(inputFidelity)
        ? inputFidelity
        : supportedFidelity[0],
    upscaleFactor: upscaleFactors.includes(state.upscaleFactor)
      ? state.upscaleFactor
      : (upscaleFactors[0] ?? 2),
  };
}

/** 会话 reducer；用户参数变更统一增加 revision，用于退出确认。 */
function reducer(state: ImageEditSessionState, action: Action): ImageEditSessionState {
  const changed = (patch: Partial<ImageEditSessionState>): ImageEditSessionState => ({
    ...state,
    ...patch,
    revision: state.revision + 1,
    error: null,
  });
  switch (action.type) {
    case 'status':
      return { ...state, status: action.status, error: action.error ?? null };
    case 'operation': {
      const operationState = changed({
        operation: action.operation,
        count:
          action.operation === 'remove_background' || action.operation === 'upscale'
            ? 1
            : state.count,
      });
      return withModelConstraints(operationState, action.model);
    }
    case 'input-mode':
      return changed({ inputMode: action.value });
    case 'source-dimensions':
      return changed({
        maskHistory: createMaskHistory(),
        outputCanvas: outputCanvasFromInsets(action.width, action.height, {
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        }),
        outpaintPreset: 'free',
        brushSizePx: Math.max(8, Math.round(Math.min(action.width, action.height) * 0.04)),
      });
    case 'input-fidelity':
      return changed({ inputFidelity: action.value });
    case 'model':
      return withModelConstraints(changed({}), action.model);
    case 'prompt':
      return changed({ prompt: action.value });
    case 'count':
      return changed({ count: Math.max(1, Math.min(action.max, Math.round(action.value))) });
    case 'mask-tool':
      return changed({ maskTool: action.value });
    case 'brush-size':
      return changed({ brushSizePx: Math.max(1, Math.min(1024, action.value)) });
    case 'mask-feather':
      return changed({ maskFeatherPx: Math.max(0, Math.min(128, Math.round(action.value))) });
    case 'mask-visible':
      return changed({ maskVisible: action.value });
    case 'mask-stroke':
      return changed({
        maskHistory: appendMaskCommand(state.maskHistory, {
          type: 'stroke',
          stroke: action.stroke,
        }),
      });
    case 'mask-clear':
      return changed({
        maskHistory: appendMaskCommand(state.maskHistory, { type: 'clear', id: uuid() }),
      });
    case 'mask-undo':
      return changed({ maskHistory: undoMaskCommand(state.maskHistory) });
    case 'mask-redo':
      return changed({ maskHistory: redoMaskCommand(state.maskHistory) });
    case 'mask-history':
      return { ...state, maskHistory: action.history };
    case 'outpaint-preset':
      return changed({
        outpaintPreset: action.value,
        outputCanvas: outputCanvasForAspectRatio(
          action.sourceWidth,
          action.sourceHeight,
          action.value,
        ),
      });
    case 'outpaint-insets':
      return changed({
        outpaintPreset: 'free',
        outputCanvas: outputCanvasFromInsets(
          state.outputCanvas.sourceWidth,
          state.outputCanvas.sourceHeight,
          action.value,
        ),
      });
    case 'upscale':
      return changed({ upscaleFactor: action.value });
  }
}

/** 创建会话初始状态。 */
function initialState(
  sourceWidth: number,
  sourceHeight: number,
  model: ModelCatalogEntry | null,
): ImageEditSessionState {
  return withModelConstraints(
    {
      status: 'editing',
      operation: 'semantic_edit',
      inputMode: 'original',
      inputFidelity: undefined,
      modelKey: model?.key ?? null,
      prompt: '',
      count: 1,
      maskTool: 'brush',
      brushSizePx: Math.max(8, Math.round(Math.min(sourceWidth, sourceHeight) * 0.04)),
      maskFeatherPx: 16,
      maskVisible: true,
      maskHistory: createMaskHistory(),
      outputCanvas: outputCanvasFromInsets(sourceWidth, sourceHeight, {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      }),
      outpaintPreset: 'free',
      upscaleFactor: 2,
      error: null,
      revision: 0,
    },
    model,
  );
}

/** Hook 属性。 */
export interface UseImageEditSessionOptions {
  sourceWidth: number;
  sourceHeight: number;
  initialModel: ModelCatalogEntry | null;
}

/** 一次编辑会话及其稳定动作。 */
export function useImageEditSession(options: UseImageEditSessionOptions) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    initialState(options.sourceWidth, options.sourceHeight, options.initialModel),
  );
  const setStatus = useCallback(
    (status: ImageEditStatus, error?: string | null) => dispatch({ type: 'status', status, error }),
    [],
  );
  return {
    state,
    dispatch,
    setStatus,
    isDirty: state.revision > 0,
    canUndoMask: state.maskHistory.cursor > 0,
    canRedoMask: state.maskHistory.cursor < state.maskHistory.commands.length,
    outpaintInsets: outputCanvasToInsets(state.outputCanvas),
  };
}
