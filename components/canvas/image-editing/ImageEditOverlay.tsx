'use client';

/**
 * 画布内精准图片编辑覆盖层。
 *
 * 覆盖层冻结打开时的图片与组内叠加快照，完成五类操作的输入准备、辅助资产上传和非破坏候选
 * 提交。准备或提交失败后保留所有参数；只有提交成功或用户确认取消才销毁局部会话。
 *
 * @module components/canvas/image-editing/ImageEditOverlay
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  Brush,
  Eraser,
  Eye,
  EyeOff,
  ImagePlus,
  Maximize2,
  Redo2,
  RemoveFormatting,
  Undo2,
  WandSparkles,
} from 'lucide-react';
import type {
  AspectRatio,
  AssetView,
  ImageGenerationParams,
  ImageOperation,
  ModelCatalogEntry,
  ProviderCredential,
  ReferenceMaterial,
} from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { nodeBox } from '@/lib/canvas/node-mapper';
import { candidatePlacementForTarget } from '@/lib/canvas/media-workflow';
import {
  candidateGeometryForOutput,
  hasMaskContent,
  scaleOutputCanvas,
  type MaskStroke,
  type OutpaintInsets,
} from '@/lib/canvas/image-editing';
import {
  compactMaskHistory,
  constrainImageSize,
  renderMaskFile,
  renderOutpaintInputFile,
  resampleImageFile,
  scaleMaskHistoryForRaster,
} from '@/lib/canvas/image-edit-renderer';
import { computeFlattenPixelSize, flattenGroupToFile } from '@/lib/canvas/flatten';
import {
  adapterForModel,
  modelsForImageOperation,
} from '@/lib/models/image-operation-capabilities';
import { deleteUnreferencedAuxiliaryAsset, uploadAsset } from '@/lib/storage/upload';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { buildPlaceholderNode, useGeneration } from '@/lib/hooks/use-generation';
import { useCanvasStore } from '@/stores/canvas-store';
import { idempotencyKey, uuid } from '@/lib/utils/id';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { ImageEditStage } from './ImageEditStage';
import { useImageEditSession } from './use-image-edit-session';

/** 精准编辑入口特性开关；生产可通过公开环境变量即时隐藏入口。 */
export const IMAGE_EDITING_ENABLED =
  process.env.NEXT_PUBLIC_IMAGE_EDITING_ENABLED?.toLowerCase() !== 'false';

type EditOperation = Exclude<ImageOperation, 'generate'>;

/** 操作展示元数据。 */
const OPERATIONS: Array<{
  operation: EditOperation;
  icon: typeof WandSparkles;
}> = [
  { operation: 'semantic_edit', icon: WandSparkles },
  { operation: 'inpaint', icon: Brush },
  { operation: 'outpaint', icon: Maximize2 },
  { operation: 'remove_background', icon: RemoveFormatting },
  { operation: 'upscale', icon: ImagePlus },
];

const OUTPAINT_RATIOS: AspectRatio[] = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];

/** 覆盖层属性。 */
export interface ImageEditOverlayProps {
  projectId: string;
  userId: string;
  conversationId: string | null;
  targetSnapshot: CanvasFlowNode;
  overlaySnapshots: CanvasFlowNode[];
  models: ModelCatalogEntry[];
  credentials: ProviderCredential[];
  credentialsLoading: boolean;
  onClose: () => void;
}

/** 从签名 URL 拉取一份可解码文件。 */
async function fetchImageFile(url: string, name: string, signal: AbortSignal): Promise<File> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`源图片读取失败（${response.status}）`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type || 'image/png' });
}

/** 根据节点已有候选数量取下一个分支槽位。 */
function nextCandidateIndex(nodes: CanvasFlowNode[], targetId: string): number {
  return nodes.filter((node) => {
    if (node.data.type === 'image' || node.data.type === 'video') {
      return node.data.candidateOf === targetId;
    }
    return (
      node.data.type === 'generation_placeholder' &&
      node.data.resultMode === 'candidate_for_target' &&
      node.data.targetNodeId === targetId
    );
  }).length;
}

/** 统一的字段容器。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

/** 画布内精准图片编辑器。 */
export function ImageEditOverlay(props: ImageEditOverlayProps) {
  const toast = useToast();
  const { t } = useTranslation();
  const { submit } = useGeneration();
  const addNode = useCanvasStore((state) => state.addNode);
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const liveTarget = useCanvasStore((state) =>
    state.nodes.find((node) => node.id === props.targetSnapshot.id),
  );
  const abortRef = useRef(new AbortController());
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const flattenedUrlRef = useRef<string | null>(null);
  const submittedRef = useRef(false);
  const [flattenedFile, setFlattenedFile] = useState<File | null>(null);
  const [previewSrc, setPreviewSrc] = useState(props.targetSnapshot.data.src as string);
  const [inputPreparing, setInputPreparing] = useState(false);
  const sourceAssetCacheRef = useRef(new Map<string, AssetView>());
  const maskAssetCacheRef = useRef(new Map<string, AssetView>());

  const originalWidth =
    props.targetSnapshot.data.type === 'image'
      ? (props.targetSnapshot.data.naturalWidth ?? Math.round(nodeBox(props.targetSnapshot).width))
      : 1;
  const originalHeight =
    props.targetSnapshot.data.type === 'image'
      ? (props.targetSnapshot.data.naturalHeight ??
        Math.round(nodeBox(props.targetSnapshot).height))
      : 1;
  const semanticModels = useMemo(
    () => modelsForImageOperation(props.models, props.credentials, 'semantic_edit'),
    [props.credentials, props.models],
  );
  const initialModel =
    semanticModels.find(
      (model) =>
        props.targetSnapshot.data.type === 'image' &&
        model.key === props.targetSnapshot.data.generationSettings.modelKey,
    ) ??
    semanticModels[0] ??
    null;
  const session = useImageEditSession({
    sourceWidth: originalWidth,
    sourceHeight: originalHeight,
    initialModel,
  });
  const { state, dispatch, setStatus } = session;
  const operationModels = useMemo(
    () => modelsForImageOperation(props.models, props.credentials, state.operation),
    [props.credentials, props.models, state.operation],
  );
  const selectedModel =
    operationModels.find((model) => model.key === state.modelKey) ?? operationModels[0] ?? null;
  const sourceWidth = state.outputCanvas.sourceWidth;
  const sourceHeight = state.outputCanvas.sourceHeight;
  const busy = ['preparing', 'uploading', 'submitting'].includes(state.status) || inputPreparing;
  const targetDeleted = !liveTarget || liveTarget.data.type !== 'image';
  const promptRequired =
    state.operation === 'semantic_edit' ||
    state.operation === 'inpaint' ||
    state.operation === 'outpaint';
  const maskMissing = state.operation === 'inpaint' && !hasMaskContent(state.maskHistory);
  const canSubmit = Boolean(
    selectedModel &&
    !targetDeleted &&
    !busy &&
    (!promptRequired || state.prompt.trim()) &&
    !maskMissing,
  );

  // 每次 effect 生命周期创建独立控制器，确保 React StrictMode 的 setup→cleanup→setup 后
  // 第二次挂载不会继续复用已中止的信号。
  useEffect(() => {
    const controller = new AbortController();
    const sourceAssetCache = sourceAssetCacheRef.current;
    const maskAssetCache = maskAssetCacheRef.current;
    abortRef.current = controller;
    return () => {
      controller.abort();
      if (flattenedUrlRef.current) URL.revokeObjectURL(flattenedUrlRef.current);
      flattenedUrlRef.current = null;
      if (!submittedRef.current) {
        const assets = new Map<string, AssetView>();
        for (const asset of sourceAssetCache.values()) assets.set(asset.id, asset);
        for (const asset of maskAssetCache.values()) assets.set(asset.id, asset);
        const supabase = getBrowserSupabase();
        for (const asset of assets.values()) {
          void deleteUnreferencedAuxiliaryAsset(supabase, {
            assetId: asset.id,
            projectId: props.projectId,
          }).catch((error) => {
            // 生命周期清理会继续兜底；控制台保留失败阶段便于排查权限或网络问题。
            // eslint-disable-next-line no-console
            console.warn('编辑辅助资产即时清理失败', error);
          });
        }
      }
    };
  }, [props.projectId]);

  // 凭据或目录异步就绪后，校正当前操作的失效模型。
  useEffect(() => {
    if (selectedModel?.key === state.modelKey) return;
    dispatch({ type: 'model', model: selectedModel });
  }, [dispatch, selectedModel, state.modelKey]);

  // 合并当前外观时冻结并渲染打开瞬间的节点快照；切回原图会释放对象 URL。
  useEffect(() => {
    let cancelled = false;
    const controller = abortRef.current;
    if (state.inputMode === 'original') {
      if (flattenedUrlRef.current) URL.revokeObjectURL(flattenedUrlRef.current);
      flattenedUrlRef.current = null;
      setFlattenedFile(null);
      setPreviewSrc(props.targetSnapshot.data.src as string);
      if (sourceWidth !== originalWidth || sourceHeight !== originalHeight) {
        dispatch({ type: 'source-dimensions', width: originalWidth, height: originalHeight });
      }
      return;
    }

    setInputPreparing(true);
    void (async () => {
      try {
        const maxInputPixels = selectedModel?.capabilities.maxInputPixels ?? 16_000_000;
        const pixelSize = computeFlattenPixelSize(props.targetSnapshot, {
          maxInputPixels,
          maxPixelEdge: 8192,
          includeBaseFrameAppearance: false,
        });
        const file = await flattenGroupToFile(props.targetSnapshot, props.overlaySnapshots, {
          maxInputPixels,
          maxPixelEdge: 8192,
          includeBaseFrameAppearance: false,
          signal: controller.signal,
        });
        if (cancelled) return;
        if (flattenedUrlRef.current) URL.revokeObjectURL(flattenedUrlRef.current);
        const url = URL.createObjectURL(file);
        flattenedUrlRef.current = url;
        setFlattenedFile(file);
        setPreviewSrc(url);
        if (sourceWidth !== pixelSize.width || sourceHeight !== pixelSize.height) {
          dispatch({ type: 'source-dimensions', width: pixelSize.width, height: pixelSize.height });
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          toast.error(error instanceof Error ? error.message : t('imageEdit.flattenFailed'));
          dispatch({ type: 'input-mode', value: 'original' });
        }
      } finally {
        if (!cancelled) setInputPreparing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    dispatch,
    originalHeight,
    originalWidth,
    props.overlaySnapshots,
    props.targetSnapshot,
    selectedModel?.capabilities.maxInputPixels,
    sourceHeight,
    sourceWidth,
    state.inputMode,
    t,
    toast,
  ]);

  // 历史超过上限时异步压平前缀；失败不破坏当前命令历史。
  useEffect(() => {
    if (state.maskHistory.commands.length <= 200) return;
    let active = true;
    void compactMaskHistory(
      state.maskHistory,
      sourceWidth,
      sourceHeight,
      abortRef.current.signal,
    ).then((history) => {
      if (active && history !== state.maskHistory) dispatch({ type: 'mask-history', history });
    });
    return () => {
      active = false;
    };
  }, [dispatch, sourceHeight, sourceWidth, state.maskHistory]);

  const changeOperation = (operation: EditOperation) => {
    const candidates = modelsForImageOperation(props.models, props.credentials, operation);
    const nextModel =
      candidates.find((model) => model.key === state.modelKey) ?? candidates[0] ?? null;
    dispatch({ type: 'operation', operation, model: nextModel });
    window.setTimeout(() => promptRef.current?.focus(), 0);
  };

  const requestClose = useCallback(() => {
    if (session.isDirty && !window.confirm(t('imageEdit.exitConfirm'))) return;
    if (busy) abortRef.current.abort();
    setStatus('cancelled');
    props.onClose();
  }, [busy, props, session.isDirty, setStatus, t]);

  /** 准备源资产；返回实际提交尺寸及引用。 */
  const prepareSource = async (
    model: ModelCatalogEntry,
    signal: AbortSignal,
  ): Promise<{
    asset: AssetView | null;
    assetId: string;
    width: number;
    height: number;
    scale: number;
  }> => {
    const maxPixels = model.capabilities.maxInputPixels ?? Number.MAX_SAFE_INTEGER;
    // 扩图会把透明边界一并作为 Provider 输入，故按完整 outputCanvas 计算降采样比例；
    // 其他操作只按源图尺寸计算。分辨率可降低，但构图比例与四边扩展量保持不变。
    const constraintWidth = state.operation === 'outpaint' ? state.outputCanvas.width : sourceWidth;
    const constraintHeight =
      state.operation === 'outpaint' ? state.outputCanvas.height : sourceHeight;
    const constrained = constrainImageSize(constraintWidth, constraintHeight, maxPixels, 8192);
    const target = {
      width: Math.max(1, Math.round(sourceWidth * constrained.scale)),
      height: Math.max(1, Math.round(sourceHeight * constrained.scale)),
      scale: constrained.scale,
    };
    const scaledOutputCanvas = scaleOutputCanvas(state.outputCanvas, target.scale);
    const adapter = adapterForModel(model, props.credentials);
    const outpaintInputKey =
      state.operation === 'outpaint' && adapter === 'openai'
        ? `:${Object.values(scaledOutputCanvas).join('x')}`
        : '';
    const cacheKey = `${state.inputMode}:${model.key}:${target.width}x${target.height}${outpaintInputKey}`;
    const cached = sourceAssetCacheRef.current.get(cacheKey);
    if (cached) {
      return {
        asset: cached,
        assetId: cached.id,
        width: cached.width ?? target.width,
        height: cached.height ?? target.height,
        scale: target.scale,
      };
    }

    const needsOpenAIOutpaintCanvas = state.operation === 'outpaint' && adapter === 'openai';
    if (
      !needsOpenAIOutpaintCanvas &&
      state.inputMode === 'original' &&
      target.scale === 1 &&
      props.targetSnapshot.data.type === 'image' &&
      props.targetSnapshot.data.assetId
    ) {
      return {
        asset: null,
        assetId: props.targetSnapshot.data.assetId,
        width: sourceWidth,
        height: sourceHeight,
        scale: 1,
      };
    }

    const inputFile =
      state.inputMode === 'flattened'
        ? flattenedFile
        : await fetchImageFile(previewSrc, `source-${props.targetSnapshot.id}.png`, signal);
    if (!inputFile) throw new Error('合并当前外观仍在准备，请稍后重试');
    const sampled = await resampleImageFile(
      inputFile,
      target.width * target.height,
      Math.max(target.width, target.height),
      signal,
    );
    // OpenAI 扩图没有独立的四边参数：把源图放入透明输出画布，透明区由 edits 端点补全。
    const uploadFile = needsOpenAIOutpaintCanvas
      ? await renderOutpaintInputFile(sampled.file, scaledOutputCanvas, signal)
      : sampled.file;
    setStatus('uploading');
    const asset = await uploadAsset(getBrowserSupabase(), {
      file: uploadFile,
      userId: props.userId,
      projectId: props.projectId,
      isAuxiliary: true,
    });
    sourceAssetCacheRef.current.set(cacheKey, asset);
    return {
      asset,
      assetId: asset.id,
      width: asset.width ?? sampled.width,
      height: asset.height ?? sampled.height,
      scale: sampled.width / sourceWidth,
    };
  };

  const submitEdit = async () => {
    if (!selectedModel || !canSubmit || props.targetSnapshot.data.type !== 'image') return;
    const controller = abortRef.current.signal.aborted ? new AbortController() : abortRef.current;
    abortRef.current = controller;
    let placeholderNodeId: string | null = null;
    try {
      setStatus('preparing');
      const prepared = await prepareSource(selectedModel, controller.signal);
      const references: ReferenceMaterial[] = [
        {
          origin: prepared.asset ? 'attachment' : 'node',
          nodeId: prepared.asset ? undefined : props.targetSnapshot.id,
          assetId: prepared.assetId,
          role: 'content',
        },
      ];

      if (state.operation === 'inpaint') {
        const maskVersion = state.maskHistory.commands
          .slice(0, state.maskHistory.cursor)
          .map((command) => (command.type === 'clear' ? command.id : command.stroke.id))
          .join(',');
        const maskKey = `luminance:${state.maskHistory.compactedCommandCount}:${maskVersion}:${prepared.width}x${prepared.height}:${state.maskFeatherPx}`;
        let maskAsset = maskAssetCacheRef.current.get(maskKey);
        if (!maskAsset) {
          const scaleX = prepared.width / sourceWidth;
          const scaleY = prepared.height / sourceHeight;
          const scaledHistory = scaleMaskHistoryForRaster(state.maskHistory, scaleX, scaleY);
          const maskFile = await renderMaskFile(
            scaledHistory,
            prepared.width,
            prepared.height,
            Math.round((state.maskFeatherPx * (scaleX + scaleY)) / 2),
            controller.signal,
            'luminance',
          );
          setStatus('uploading');
          maskAsset = await uploadAsset(getBrowserSupabase(), {
            file: maskFile,
            userId: props.userId,
            projectId: props.projectId,
            isAuxiliary: true,
          });
          maskAssetCacheRef.current.set(maskKey, maskAsset);
        }
        references.push({ origin: 'attachment', assetId: maskAsset.id, role: 'mask' });
      }

      const common = {
        modality: 'image' as const,
        operation: state.operation,
        inputMode: state.inputMode,
        inputFidelity: state.inputFidelity,
        references,
        count: state.count,
        // 编辑模型若依赖显式输出尺寸，应以实际上传源图为准；扩图会在下方用 outputCanvas 覆盖。
        width: prepared.width,
        height: prepared.height,
      };
      let params: ImageGenerationParams;
      if (state.operation === 'inpaint') {
        params = {
          ...common,
          operation: 'inpaint',
          maskFeatherPx: Math.round(state.maskFeatherPx * prepared.scale),
        };
      } else if (state.operation === 'outpaint') {
        params = {
          ...common,
          operation: 'outpaint',
          outputCanvas:
            prepared.scale === 1
              ? state.outputCanvas
              : scaleOutputCanvas(state.outputCanvas, prepared.scale),
        };
      } else if (state.operation === 'remove_background') {
        params = {
          ...common,
          operation: 'remove_background',
          count: 1,
          background: 'transparent',
        };
      } else if (state.operation === 'upscale') {
        params = {
          ...common,
          operation: 'upscale',
          count: 1,
          upscaleFactor: state.upscaleFactor,
        };
      } else {
        params = { ...common, operation: 'semantic_edit' };
      }

      const nodes = useCanvasStore.getState().nodes;
      const index = nextCandidateIndex(nodes, props.targetSnapshot.id);
      let placement = candidatePlacementForTarget(props.targetSnapshot, index);
      if (state.operation === 'outpaint') {
        const geometry = candidateGeometryForOutput(
          nodeBox(props.targetSnapshot),
          state.outputCanvas,
        );
        // 候选仍按分支槽位排布，只采用扩图后的宽高；真正采用时由事务以主节点中心重定位。
        placement = { ...placement, width: geometry.width, height: geometry.height };
      }
      placeholderNodeId = uuid();
      const placeholder = buildPlaceholderNode({
        placement,
        modality: 'image',
        promptSummary: state.prompt.trim() || t(`imageEdit.operation.${state.operation}`),
        nodeId: placeholderNodeId,
      });
      placeholder.data = {
        ...placeholder.data,
        targetNodeId: props.targetSnapshot.id,
        resultMode: 'candidate_for_target',
      };
      addNode(placeholder, { select: false, persist: false });

      setStatus('submitting');
      await submit({
        projectId: props.projectId,
        conversationId: props.conversationId,
        messageId: null,
        modality: 'image',
        modelKey: selectedModel.key,
        prompt: state.prompt.trim(),
        params,
        idempotencyKey: idempotencyKey(),
        placement,
        placeholderNodeId,
        targetNodeId: props.targetSnapshot.id,
        resultMode: 'candidate_for_target',
      });
      setStatus('waiting');
      submittedRef.current = true;
      toast.success(t('imageEdit.submitted'));
      props.onClose();
    } catch (error) {
      if (placeholderNodeId) removeNodes([placeholderNodeId], { persist: false });
      const message = controller.signal.aborted
        ? t('imageEdit.cancelled')
        : error instanceof Error
          ? error.message
          : t('imageEdit.submitFailed');
      setStatus('failure', message);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inField =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      dispatch({ type: event.shiftKey ? 'mask-redo' : 'mask-undo' });
      return;
    }
    if (inField) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSubmit) {
        event.preventDefault();
        void submitEdit();
      }
      return;
    }
    if (event.key.toLowerCase() === 'b') dispatch({ type: 'mask-tool', value: 'brush' });
    else if (event.key.toLowerCase() === 'e') dispatch({ type: 'mask-tool', value: 'eraser' });
    else if (event.key === '[') dispatch({ type: 'brush-size', value: state.brushSizePx - 4 });
    else if (event.key === ']') dispatch({ type: 'brush-size', value: state.brushSizePx + 4 });
    else if (event.key === 'Enter' && canSubmit) void submitEdit();
  };

  const setOutpaintInset = (side: keyof OutpaintInsets, value: number) => {
    dispatch({
      type: 'outpaint-insets',
      value: { ...session.outpaintInsets, [side]: Math.max(0, Math.round(value)) },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        showClose={false}
        className="flex h-[min(94vh,900px)] w-[min(96vw,1480px)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          requestClose();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          window.setTimeout(() => promptRef.current?.focus(), 0);
        }}
        onKeyDown={onKeyDown}
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-5">
          <div>
            <DialogTitle className="text-base font-semibold">{t('imageEdit.title')}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {t('imageEdit.description')}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={requestClose} disabled={state.status === 'submitting'}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!canSubmit} onClick={() => void submitEdit()}>
              {t('imageEdit.submit')}
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            <div className="flex flex-wrap gap-1 rounded-xl bg-muted p-1" role="tablist">
              {OPERATIONS.map(({ operation, icon: Icon }) => {
                const count = modelsForImageOperation(
                  props.models,
                  props.credentials,
                  operation,
                ).length;
                return (
                  <button
                    key={operation}
                    type="button"
                    role="tab"
                    aria-selected={state.operation === operation}
                    className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors ${
                      state.operation === operation
                        ? 'bg-background font-medium text-foreground shadow-soft'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => changeOperation(operation)}
                  >
                    <Icon className="size-4" />
                    {t(`imageEdit.operation.${operation}`)}
                    <span className="text-[10px] text-muted-foreground">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="relative min-h-0 flex-1">
              {inputPreparing ? (
                <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-sm">
                  <Spinner label={t('imageEdit.flattening')} />
                </div>
              ) : null}
              <ImageEditStage
                src={previewSrc}
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
                operation={state.operation}
                maskHistory={state.maskHistory}
                maskTool={state.maskTool}
                brushSizePx={state.brushSizePx}
                maskVisible={state.maskVisible}
                outputCanvas={state.outputCanvas}
                disabled={busy || targetDeleted}
                onStroke={(stroke: MaskStroke) => dispatch({ type: 'mask-stroke', stroke })}
                onOutpaintInsetsChange={(value) => dispatch({ type: 'outpaint-insets', value })}
              />
            </div>

            {state.operation === 'inpaint' ? (
              <div className="flex items-center gap-1 rounded-xl border border-border bg-card p-2">
                <IconButton
                  label={t('imageEdit.maskBrush')}
                  active={state.maskTool === 'brush'}
                  onClick={() => dispatch({ type: 'mask-tool', value: 'brush' })}
                >
                  <Brush />
                </IconButton>
                <IconButton
                  label={t('imageEdit.maskEraser')}
                  active={state.maskTool === 'eraser'}
                  onClick={() => dispatch({ type: 'mask-tool', value: 'eraser' })}
                >
                  <Eraser />
                </IconButton>
                <input
                  aria-label={t('imageEdit.maskSize')}
                  type="range"
                  min={1}
                  max={Math.min(1024, Math.round(Math.min(sourceWidth, sourceHeight) / 2))}
                  value={state.brushSizePx}
                  onChange={(event) =>
                    dispatch({ type: 'brush-size', value: Number(event.target.value) })
                  }
                  className="mx-2 w-36 accent-[hsl(var(--accent))]"
                />
                <span className="w-16 text-xs text-muted-foreground">{state.brushSizePx}px</span>
                <IconButton
                  label={t('imageEdit.maskUndo')}
                  disabled={!session.canUndoMask}
                  onClick={() => dispatch({ type: 'mask-undo' })}
                >
                  <Undo2 />
                </IconButton>
                <IconButton
                  label={t('imageEdit.maskRedo')}
                  disabled={!session.canRedoMask}
                  onClick={() => dispatch({ type: 'mask-redo' })}
                >
                  <Redo2 />
                </IconButton>
                <IconButton
                  label={state.maskVisible ? t('imageEdit.maskHide') : t('imageEdit.maskShow')}
                  onClick={() => dispatch({ type: 'mask-visible', value: !state.maskVisible })}
                >
                  {state.maskVisible ? <Eye /> : <EyeOff />}
                </IconButton>
                <Button size="sm" variant="ghost" onClick={() => dispatch({ type: 'mask-clear' })}>
                  {t('imageEdit.maskClear')}
                </Button>
              </div>
            ) : null}
          </main>

          <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-border bg-card p-4">
            <div className="flex flex-col gap-4">
              {targetDeleted ? (
                <div className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                  {t('imageEdit.targetDeleted')}
                </div>
              ) : null}
              {liveTarget &&
              liveTarget.data.type === 'image' &&
              liveTarget.data.src !== props.targetSnapshot.data.src ? (
                <div className="border-warning/30 bg-warning/10 rounded-xl border p-3 text-xs text-foreground">
                  {t('imageEdit.targetChanged')}
                </div>
              ) : null}

              <Field label={t('imageEdit.inputSource')}>
                <select
                  value={state.inputMode}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({
                      type: 'input-mode',
                      value: event.target.value as 'original' | 'flattened',
                    })
                  }
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                >
                  <option value="original">{t('imageEdit.inputOriginal')}</option>
                  <option value="flattened">{t('imageEdit.inputFlattened')}</option>
                </select>
              </Field>

              <Field label={t('imageEdit.model')}>
                <select
                  value={selectedModel?.key ?? ''}
                  disabled={busy || props.credentialsLoading || operationModels.length === 0}
                  onChange={(event) =>
                    dispatch({
                      type: 'model',
                      model:
                        operationModels.find((model) => model.key === event.target.value) ?? null,
                    })
                  }
                  className="h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                >
                  {operationModels.map((model) => (
                    <option key={model.key} value={model.key}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
                {!props.credentialsLoading && operationModels.length === 0 ? (
                  <span className="rounded-lg bg-muted p-2 text-xs font-normal leading-relaxed text-muted-foreground">
                    {t('imageEdit.noModel')}
                  </span>
                ) : null}
              </Field>

              {selectedModel?.capabilities.inputFidelityOptions?.length ? (
                <Field label={t('imageEdit.fidelity')}>
                  <select
                    value={state.inputFidelity ?? ''}
                    onChange={(event) =>
                      dispatch({
                        type: 'input-fidelity',
                        value: event.target.value as 'standard' | 'high',
                      })
                    }
                    className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                  >
                    {selectedModel.capabilities.inputFidelityOptions.map((fidelity) => (
                      <option key={fidelity} value={fidelity}>
                        {fidelity === 'high'
                          ? t('imageEdit.fidelityHigh')
                          : t('imageEdit.fidelityStandard')}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {promptRequired ? (
                <Field label={t('imageEdit.prompt')}>
                  <textarea
                    ref={promptRef}
                    value={state.prompt}
                    rows={4}
                    placeholder={t(`imageEdit.prompt.${state.operation}`)}
                    onChange={(event) => dispatch({ type: 'prompt', value: event.target.value })}
                    className="resize-none rounded-lg border border-border bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                  />
                </Field>
              ) : null}

              {state.operation === 'inpaint' ? (
                <Field label={t('imageEdit.maskFeather', { value: state.maskFeatherPx })}>
                  <input
                    type="range"
                    min={0}
                    max={128}
                    value={state.maskFeatherPx}
                    onChange={(event) =>
                      dispatch({ type: 'mask-feather', value: Number(event.target.value) })
                    }
                    className="accent-[hsl(var(--accent))]"
                  />
                </Field>
              ) : null}

              {state.operation === 'outpaint' ? (
                <>
                  <Field label={t('imageEdit.outputRatio')}>
                    <div className="grid grid-cols-4 gap-1">
                      {OUTPAINT_RATIOS.map((ratio) => (
                        <button
                          key={ratio}
                          type="button"
                          className={`h-8 rounded-md border text-xs ${
                            state.outpaintPreset === ratio
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border bg-background'
                          }`}
                          onClick={() =>
                            dispatch({
                              type: 'outpaint-preset',
                              value: ratio,
                              sourceWidth,
                              sourceHeight,
                            })
                          }
                        >
                          {ratio}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={`h-8 rounded-md border text-xs ${
                          state.outpaintPreset === 'free'
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border bg-background'
                        }`}
                        onClick={() =>
                          dispatch({ type: 'outpaint-insets', value: session.outpaintInsets })
                        }
                      >
                        {t('imageEdit.free')}
                      </button>
                    </div>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                      <Field key={side} label={t(`imageEdit.side.${side}`)}>
                        <input
                          type="number"
                          min={0}
                          value={session.outpaintInsets[side]}
                          onChange={(event) => setOutpaintInset(side, Number(event.target.value))}
                          className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                        />
                      </Field>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('imageEdit.outputSummary', {
                      width: state.outputCanvas.width,
                      height: state.outputCanvas.height,
                      x: state.outputCanvas.sourceX,
                      y: state.outputCanvas.sourceY,
                    })}
                  </p>
                </>
              ) : null}

              {state.operation === 'upscale' ? (
                <Field label={t('imageEdit.upscaleFactor')}>
                  <div className="grid grid-cols-2 gap-2">
                    {(selectedModel?.capabilities.upscaleFactors ?? []).map((factor) => (
                      <button
                        key={factor}
                        type="button"
                        className={`h-10 rounded-lg border text-sm ${
                          state.upscaleFactor === factor
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-border bg-background'
                        }`}
                        onClick={() => dispatch({ type: 'upscale', value: factor })}
                      >
                        {factor}×
                      </button>
                    ))}
                  </div>
                </Field>
              ) : null}

              {state.operation !== 'remove_background' && state.operation !== 'upscale' ? (
                <Field label={t('imageEdit.candidateCount')}>
                  <input
                    type="number"
                    min={1}
                    max={Math.min(4, selectedModel?.capabilities.maxOutputs ?? 1)}
                    value={state.count}
                    onChange={(event) =>
                      dispatch({
                        type: 'count',
                        value: Number(event.target.value),
                        max: Math.min(4, selectedModel?.capabilities.maxOutputs ?? 1),
                      })
                    }
                    className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
                  />
                </Field>
              ) : null}

              <div className="rounded-xl bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                {t('imageEdit.inputSummary', { width: sourceWidth, height: sourceHeight })}
                {selectedModel?.capabilities.maxInputPixels
                  ? ` · ${t('imageEdit.modelLimit', {
                      pixels: selectedModel.capabilities.maxInputPixels.toLocaleString(),
                    })}`
                  : ''}
                {' · '}
                {t('imageEdit.geometryHint')}
              </div>

              {maskMissing ? (
                <p className="text-xs text-danger">{t('imageEdit.maskMissing')}</p>
              ) : null}
              {state.error ? (
                <div
                  role="alert"
                  className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
                >
                  {state.error}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
