'use client';

/**
 * 媒体侧卡节点。
 *
 * 每个侧卡绑定一张图片或一段视频，承载该媒体自己的对话、媒体描述与生成配置。
 *
 * @module components/canvas/nodes/MediaPanelNode
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import {
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Loader2,
  MessageSquare,
  Send,
  Settings2,
  Video,
} from 'lucide-react';
import type {
  AspectRatio,
  ImageGenerationParams,
  ImageQuality,
  ImageNodeData,
  ImageSizePreset,
  MediaGenerationSettings,
  MediaPanelNodeData,
  MessageRow,
  ModelCatalogEntry,
  Provider,
  ReferenceMaterial,
  VideoNodeData,
  VideoGenerationParams,
} from '@/types';
import { ASPECT_RATIOS, IMAGE_QUALITIES } from '@/types';
import { nodeBox, type CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { candidatePlacementForTarget } from '@/lib/canvas/media-workflow';
import { composeReferenceImageEditPrompt } from '@/lib/generation/reference-prompt';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useGeneration, buildPlaceholderNode } from '@/lib/hooks/use-generation';
import { useWorkbenchModelSource } from '@/lib/hooks/use-workbench-model-source';
import { customProviderDefinition, PROVIDER_DEFINITIONS } from '@/lib/models/providers';
import { useCanvasStore } from '@/stores/canvas-store';
import { idempotencyKey, uuid } from '@/lib/utils/id';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

type MediaCanvasFlowNode = CanvasFlowNode & { data: ImageNodeData | VideoNodeData };

const IMAGE_SIZE_PRESETS: Array<{ value: ImageSizePreset; label: string; base?: number }> = [
  { value: '1k', label: '1K', base: 1024 },
  { value: '2k', label: '2K', base: 2048 },
  { value: '4k', label: '4K', base: 4096 },
  { value: '8k', label: '8K', base: 8192 },
  { value: 'custom', label: '自定义宽高' },
];

const MEDIA_PANEL_FALLBACK_WIDTH = 360;
const MEDIA_PANEL_COLLAPSED_HEIGHT = 56;
const MEDIA_PANEL_EXPANDED_HEIGHT = 560;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dimensionsFromPreset(
  preset: ImageSizePreset | undefined,
  aspectRatio: AspectRatio | undefined,
): { width?: number; height?: number } {
  const option = IMAGE_SIZE_PRESETS.find((item) => item.value === preset);
  if (!option?.base) return {};
  const [rawW, rawH] = (aspectRatio ?? '1:1').split(':').map(Number);
  const ratioW = rawW || 1;
  const ratioH = rawH || 1;
  if (ratioW >= ratioH) {
    return { width: option.base, height: Math.round((option.base * ratioH) / ratioW) };
  }
  return { width: Math.round((option.base * ratioW) / ratioH), height: option.base };
}

function isMediaNode(node: CanvasFlowNode | undefined): node is MediaCanvasFlowNode {
  return node?.data.type === 'image' || node?.data.type === 'video';
}

/** 取得可用于图片编辑 / 图生视频的图片资产，避免把视频文件误传成首帧。 */
function generationReferenceAssetId(target: MediaCanvasFlowNode | null): string | null {
  if (!target) return null;
  const candidate = target.data.type === 'image' ? target.data.assetId : target.data.posterAssetId;
  return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
}

function settingsFor(target: MediaCanvasFlowNode): MediaGenerationSettings {
  const current = target.data.generationSettings;
  if (target.data.type === 'video') {
    return {
      modelKey: current.modelKey,
      count: current.count || 1,
      aspectRatio: current.aspectRatio ?? '16:9',
      durationSec: current.durationSec ?? 5,
      resolution: current.resolution ?? '720p',
      fps: current.fps ?? 24,
      motionStrength: current.motionStrength,
    };
  }
  return {
    modelKey: current.modelKey,
    count: current.count || 1,
    aspectRatio: current.aspectRatio ?? '1:1',
    sizePreset: current.sizePreset ?? (current.width && current.height ? 'custom' : '1k'),
    width: current.width,
    height: current.height,
    quality: current.quality,
  };
}

function eligibleModels(
  targetType: 'image' | 'video',
  models: ModelCatalogEntry[],
  enabledProviders: ReadonlySet<Provider>,
): ModelCatalogEntry[] {
  return models.filter(
    (model) =>
      model.modality === targetType && model.isActive && enabledProviders.has(model.provider),
  );
}

/** 保留节点已选模型；不再可用时回退到当前节点的首个合格模型。 */
function pickModel(
  settings: MediaGenerationSettings,
  models: ModelCatalogEntry[],
): ModelCatalogEntry | null {
  return models.find((m) => m.key === settings.modelKey) ?? models[0] ?? null;
}

function clampCount(value: number, model: ModelCatalogEntry | null): number {
  const max = Math.max(1, model?.capabilities.maxOutputs ?? 1);
  return Math.min(max, Math.max(1, Math.floor(value || 1)));
}

/** 按当前模型能力解析实际提交的比例，避免下拉显示回退值但请求仍携带旧值。 */
function effectiveAspectRatioFor(
  requested: AspectRatio | undefined,
  model: ModelCatalogEntry | null,
): AspectRatio | undefined {
  const supported = model?.capabilities.aspectRatios ?? [];
  if (requested && supported.includes(requested)) return requested;
  const preferred = model?.defaultParams.aspectRatio;
  if (preferred && supported.includes(preferred)) return preferred;
  return supported[0] ?? requested;
}

/** 按当前视频模型能力解析实际分辨率。 */
function effectiveVideoResolutionFor(
  requested: string | undefined,
  model: ModelCatalogEntry | null,
): string {
  const supported = model?.capabilities.videoResolutions ?? [];
  if (requested && supported.includes(requested)) return requested;
  const preferred = model?.defaultParams.resolution;
  if (preferred && supported.includes(preferred)) return preferred;
  return supported[0] ?? requested ?? preferred ?? '720p';
}

/** 按当前视频模型声明的时长范围夹取实际秒数。 */
function effectiveVideoDurationFor(
  requested: number | undefined,
  model: ModelCatalogEntry | null,
): number {
  const value = requested ?? model?.defaultParams.durationSec ?? 5;
  const range = model?.capabilities.videoDurationRange;
  return range ? Math.min(range.max, Math.max(range.min, value)) : value;
}

function MessageRowView({ message }: { message: MessageRow }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed',
          isUser ? 'bg-accent text-accent-foreground' : 'bg-muted text-foreground',
        )}
      >
        {message.content}
      </div>
    </div>
  );
}

function MediaPanelNodeComponent({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const d = data as MediaPanelNodeData;
  const toast = useToast();
  const { submit } = useGeneration();
  const {
    models,
    credentials: providerCredentialRows,
    credentialsLoading,
  } = useWorkbenchModelSource();

  const projectId = useCanvasStore((s) => s.projectId);
  const nodes = useCanvasStore((s) => s.nodes);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const addNode = useCanvasStore((s) => s.addNode);
  const replaceNode = useCanvasStore((s) => s.replaceNode);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const panelNode = nodes.find((n) => n.id === id);
  const target = nodes.find((n) => n.id === d.targetNodeId);
  const mediaTarget = isMediaNode(target) ? target : null;
  const targetId = mediaTarget?.id ?? null;
  const targetType = mediaTarget?.data.type ?? null;
  const referenceAssetId = generationReferenceAssetId(mediaTarget);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const loadingConversationRef = useRef(false);

  const settings: MediaGenerationSettings = mediaTarget
    ? settingsFor(mediaTarget)
    : { modelKey: null, count: 1 };
  const enabledProviders = useMemo(
    () =>
      new Set(
        providerCredentialRows
          .filter((credential) => credential.enabled)
          .map((credential) => credential.provider),
      ),
    [providerCredentialRows],
  );
  const modelOptions = useMemo(
    () => (mediaTarget ? eligibleModels(mediaTarget.data.type, models, enabledProviders) : []),
    [enabledProviders, mediaTarget, models],
  );
  const selectableModels = useMemo(
    () =>
      modelOptions.filter(
        (option) => !option.capabilities.requiresReferenceImages || Boolean(referenceAssetId),
      ),
    [modelOptions, referenceAssetId],
  );
  const model = pickModel(settings, selectableModels);
  const effectiveCount = clampCount(settings.count, model);
  const effectiveAspectRatio = effectiveAspectRatioFor(settings.aspectRatio, model);
  const effectiveVideoResolution = effectiveVideoResolutionFor(settings.resolution, model);
  const effectiveVideoDuration = effectiveVideoDurationFor(settings.durationSec, model);
  const modelGroups = useMemo(() => {
    const definitions = [
      ...PROVIDER_DEFINITIONS,
      ...providerCredentialRows
        .filter((credential) => credential.provider.startsWith('custom:'))
        .map(customProviderDefinition),
    ];
    return definitions
      .map((definition) => ({
        definition,
        models: modelOptions.filter((option) => option.provider === definition.id),
      }))
      .filter((group) => group.models.length > 0);
  }, [modelOptions, providerCredentialRows]);
  const aspectRatioOptions = model?.capabilities.aspectRatios.length
    ? model.capabilities.aspectRatios
    : ASPECT_RATIOS;
  const qualityOptions = IMAGE_QUALITIES.filter((quality) =>
    model?.capabilities.qualities.includes(quality),
  );
  const videoResolutionOptions = model?.capabilities.videoResolutions ?? [];

  const setPanelCollapsed = useCallback(
    (collapsed: boolean) => {
      const width = mediaTarget
        ? nodeBox(mediaTarget).width
        : typeof panelNode?.width === 'number'
          ? panelNode.width
          : MEDIA_PANEL_FALLBACK_WIDTH;
      const height = collapsed ? MEDIA_PANEL_COLLAPSED_HEIGHT : MEDIA_PANEL_EXPANDED_HEIGHT;
      updateNodeData(id, { collapsed });
      updateNode(id, {
        width,
        height,
        style: { width, height },
      });
      if (!collapsed) bringToFront([id]);
    },
    [bringToFront, id, mediaTarget, panelNode?.width, updateNode, updateNodeData],
  );

  const loadConversation = useCallback(async (): Promise<'loaded' | 'retry' | 'idle'> => {
    if (!projectId || !targetId || !targetType) return 'idle';
    const supabase = getBrowserSupabase();
    const { data: targetRow, error: targetError } = await supabase
      .from('canvas_nodes')
      .select('id')
      .eq('id', targetId)
      .maybeSingle();
    if (targetError) {
      toast.error(targetError.message);
      return 'idle';
    }
    if (!targetRow) return 'retry';

    let cid: string | null = null;
    const { data: existing } = await supabase
      .from('conversations')
      .select('id')
      .eq('project_id', projectId)
      .eq('target_node_id', targetId)
      .maybeSingle();
    cid = existing?.id ?? null;
    if (!cid) {
      const { data: created, error } = await supabase
        .from('conversations')
        .insert({
          project_id: projectId,
          target_node_id: targetId,
          title: targetType === 'image' ? '图片对话' : '视频对话',
        })
        .select('id')
        .single();
      if (error || !created) {
        if ((error as { code?: string } | null)?.code === '23503') return 'retry';
        const { data: raced } = await supabase
          .from('conversations')
          .select('id')
          .eq('project_id', projectId)
          .eq('target_node_id', targetId)
          .maybeSingle();
        if (raced?.id) {
          cid = raced.id;
        } else if ((error as { code?: string } | null)?.code === '23505') {
          return 'retry';
        } else {
          toast.error(error?.message ?? '创建媒体对话失败');
          return 'idle';
        }
      } else {
        cid = created.id;
      }
    }
    setConversationId(cid);
    const { data: rows } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', cid)
      .order('created_at', { ascending: true })
      .limit(80);
    setMessages((rows ?? []) as MessageRow[]);
    return 'loaded';
  }, [projectId, targetId, targetType, toast]);

  useEffect(() => {
    if (d.collapsed) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      if (loadingConversationRef.current) return;
      loadingConversationRef.current = true;
      try {
        const result = await loadConversation();
        if (!cancelled && result === 'retry') {
          retryTimer = setTimeout(() => void run(), 500);
        }
      } finally {
        loadingConversationRef.current = false;
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [d.collapsed, loadConversation]);

  useEffect(() => {
    if (!d.collapsed) bringToFront([id]);
  }, [bringToFront, d.collapsed, id]);

  useEffect(() => {
    if (!mediaTarget || !panelNode) return;
    const width = nodeBox(mediaTarget).width;
    const height = d.collapsed ? MEDIA_PANEL_COLLAPSED_HEIGHT : MEDIA_PANEL_EXPANDED_HEIGHT;
    const currentWidth =
      typeof panelNode.width === 'number' ? panelNode.width : MEDIA_PANEL_FALLBACK_WIDTH;
    const currentHeight = typeof panelNode.height === 'number' ? panelNode.height : height;
    if (currentWidth === width && currentHeight === height) return;
    updateNode(id, {
      width,
      height,
      style: { width, height },
    });
  }, [d.collapsed, id, mediaTarget, panelNode, updateNode]);

  const updateSettings = (patch: Partial<MediaGenerationSettings>) => {
    if (!mediaTarget) return;
    updateNodeData(mediaTarget.id, {
      generationSettings: { ...settings, ...patch },
    });
  };

  /** 切换模型，并把节点参数校正到新模型声明的能力范围内。 */
  const selectModel = (modelKey: string) => {
    const next = modelOptions.find((option) => option.key === modelKey);
    if (!next) return;
    const nextRatios = next.capabilities.aspectRatios;
    const defaultRatio = next.defaultParams.aspectRatio;
    const aspectRatio = nextRatios.includes(settings.aspectRatio as AspectRatio)
      ? settings.aspectRatio
      : defaultRatio && nextRatios.includes(defaultRatio)
        ? defaultRatio
        : nextRatios[0];

    if (mediaTarget?.data.type === 'video') {
      const resolutions = next.capabilities.videoResolutions ?? [];
      const resolution = resolutions.includes(settings.resolution ?? '')
        ? settings.resolution
        : (next.defaultParams.resolution ?? resolutions[0]);
      const range = next.capabilities.videoDurationRange;
      const duration = settings.durationSec ?? next.defaultParams.durationSec ?? range?.min ?? 5;
      updateSettings({
        modelKey,
        count: clampCount(settings.count, next),
        aspectRatio,
        resolution,
        durationSec: range ? Math.min(range.max, Math.max(range.min, duration)) : duration,
        fps: next.defaultParams.fps ?? settings.fps,
      });
      return;
    }

    const qualities = next.capabilities.qualities;
    const quality =
      settings.quality && qualities.includes(settings.quality)
        ? settings.quality
        : next.defaultParams.quality && qualities.includes(next.defaultParams.quality)
          ? next.defaultParams.quality
          : undefined;
    updateSettings({
      modelKey,
      count: clampCount(settings.count, next),
      aspectRatio,
      quality,
    });
  };

  // 旧节点可能保存着上一个模型的 1080p / 长时长参数；模型目录加载后立即校正并持久化。
  useEffect(() => {
    if (mediaTarget?.data.type !== 'video' || !model) return;
    const fps = settings.fps ?? model.defaultParams.fps ?? 24;
    if (
      settings.modelKey === model.key &&
      settings.count === effectiveCount &&
      settings.aspectRatio === effectiveAspectRatio &&
      settings.resolution === effectiveVideoResolution &&
      settings.durationSec === effectiveVideoDuration &&
      settings.fps === fps
    ) {
      return;
    }
    updateNodeData(mediaTarget.id, {
      generationSettings: {
        ...mediaTarget.data.generationSettings,
        modelKey: model.key,
        count: effectiveCount,
        aspectRatio: effectiveAspectRatio,
        resolution: effectiveVideoResolution,
        durationSec: effectiveVideoDuration,
        fps,
      },
    });
  }, [
    effectiveAspectRatio,
    effectiveCount,
    effectiveVideoDuration,
    effectiveVideoResolution,
    mediaTarget,
    model,
    settings.aspectRatio,
    settings.count,
    settings.durationSec,
    settings.fps,
    settings.modelKey,
    settings.resolution,
    updateNodeData,
  ]);

  const updateDescription = (value: string) => {
    if (!mediaTarget) return;
    updateNodeData(mediaTarget.id, { mediaDescription: value });
  };

  const updateImageAspectRatio = (aspectRatio: AspectRatio) => {
    const preset = settings.sizePreset ?? '1k';
    updateSettings({
      aspectRatio,
      ...(preset === 'custom' ? {} : dimensionsFromPreset(preset, aspectRatio)),
    });
  };

  const updateImageSizePreset = (sizePreset: ImageSizePreset) => {
    updateSettings({
      sizePreset,
      ...(sizePreset === 'custom'
        ? {}
        : dimensionsFromPreset(sizePreset, settings.aspectRatio as AspectRatio | undefined)),
    });
  };

  const submitOne = async (
    messageId: string,
    prompt: string,
    promptSummary: string,
    index: number,
    count: number,
    resultMode: 'new_primary' | 'candidate_for_target',
  ) => {
    if (!projectId || !mediaTarget || !model) return;
    const targetType = mediaTarget.data.type;
    const isPrimaryResult = resultMode === 'new_primary';
    const acceptsTargetReference =
      targetType === 'image'
        ? model.capabilities.supportsReferenceImages
        : model.capabilities.supportsImageToVideo;
    const references: ReferenceMaterial[] =
      referenceAssetId && acceptsTargetReference
        ? [
            {
              origin: 'node',
              nodeId: mediaTarget.id,
              assetId: referenceAssetId,
              role: targetType === 'video' ? 'first_frame' : 'content',
            },
          ]
        : [];
    const placement = isPrimaryResult
      ? { ...nodeBox(mediaTarget), parentId: mediaTarget.parentId ?? null }
      : candidatePlacementForTarget(mediaTarget, index);
    const placeholderNodeId = isPrimaryResult ? mediaTarget.id : uuid();
    const placeholderNode = buildPlaceholderNode({
      placement,
      modality: targetType,
      promptSummary,
      nodeId: placeholderNodeId,
    });
    placeholderNode.data = {
      ...placeholderNode.data,
      targetNodeId: mediaTarget.id,
      resultMode,
    };
    if (isPrimaryResult) {
      setPanelCollapsed(true);
      replaceNode(
        mediaTarget.id,
        {
          ...placeholderNode,
          zIndex: mediaTarget.zIndex,
          selected: mediaTarget.selected,
        },
        { persist: false },
      );
    } else {
      addNode(placeholderNode, { select: false, persist: false });
    }

    try {
      if (targetType === 'image') {
        const presetDimensions =
          settings.sizePreset === 'custom'
            ? { width: settings.width, height: settings.height }
            : dimensionsFromPreset(
                (settings.sizePreset ?? '1k') as ImageSizePreset,
                effectiveAspectRatio,
              );
        const params: ImageGenerationParams = {
          modality: 'image',
          references,
          count,
          aspectRatio: effectiveAspectRatio,
          width: presetDimensions.width,
          height: presetDimensions.height,
          sizePreset: settings.sizePreset ?? '1k',
          quality: settings.quality,
        };
        await submit({
          projectId,
          conversationId,
          messageId,
          modality: 'image',
          modelKey: model.key,
          prompt,
          params,
          idempotencyKey: idempotencyKey(),
          placement,
          placeholderNodeId,
          targetNodeId: mediaTarget.id,
          resultMode,
        });
      } else {
        const params: VideoGenerationParams = {
          modality: 'video',
          references,
          durationSec: effectiveVideoDuration,
          resolution: effectiveVideoResolution,
          aspectRatio: effectiveAspectRatio,
          fps: settings.fps ?? 24,
          motionStrength: settings.motionStrength,
        };
        await submit({
          projectId,
          conversationId,
          messageId,
          modality: 'video',
          modelKey: model.key,
          prompt,
          params,
          idempotencyKey: idempotencyKey(),
          placement,
          placeholderNodeId,
          targetNodeId: mediaTarget.id,
          resultMode,
        });
      }
    } catch (err) {
      if (isPrimaryResult) {
        replaceNode(mediaTarget.id, mediaTarget, { persist: false });
      } else {
        removeNodes([placeholderNodeId], { persist: false });
      }
      throw err;
    }
  };

  const handleSend = async () => {
    if (!projectId || !mediaTarget || !conversationId || !model || sending) return;
    const flowText = draft.trim();
    const mediaText = mediaTarget.data.mediaDescription.trim();
    if (!flowText && !mediaText) return;

    setSending(true);
    const messageId = uuid();
    const targetHasAsset = Boolean(mediaTarget.data.assetId);
    const content =
      flowText || (targetHasAsset ? '按当前媒体描述生成候选' : '按当前媒体描述生成目标');
    try {
      const supabase = getBrowserSupabase();
      const { data: inserted, error } = await supabase
        .from('messages')
        .insert({
          id: messageId,
          conversation_id: conversationId,
          role: 'user',
          content,
          model_key: model.key,
          agent_mode: 'generate',
          mentions: [
            {
              nodeId: mediaTarget.id,
              nodeType: mediaTarget.data.type,
              label: mediaTarget.data.type === 'image' ? '目标图片' : '目标视频',
              assetId: mediaTarget.data.assetId,
            },
          ],
          attachments: [],
        })
        .select('*')
        .single();
      if (error || !inserted) throw error ?? new Error('保存消息失败');
      setMessages((prev) => [...prev, inserted as MessageRow]);
      setDraft('');

      const rawInstruction = [mediaText, flowText].filter(Boolean).join('\n');
      const basePrompt =
        mediaTarget.data.type === 'image' && targetHasAsset
          ? composeReferenceImageEditPrompt(rawInstruction)
          : [mediaText ? `媒体描述：${mediaText}` : '', flowText ? `流程要求：${flowText}` : '']
              .filter(Boolean)
              .join('\n\n');
      const promptSummary = rawInstruction || basePrompt;
      const existing = nodes.filter(
        (n) =>
          (n.data.type === 'image' || n.data.type === 'video') &&
          n.data.candidateOf === mediaTarget.id,
      ).length;

      if (mediaTarget.data.type === 'image') {
        await submitOne(
          messageId,
          basePrompt,
          promptSummary,
          existing,
          effectiveCount,
          targetHasAsset ? 'candidate_for_target' : 'new_primary',
        );
      } else {
        if (!targetHasAsset) {
          await submitOne(messageId, basePrompt, promptSummary, existing, 1, 'new_primary');
        }
        const candidateCount = targetHasAsset ? effectiveCount : Math.max(0, effectiveCount - 1);
        for (let i = 0; i < candidateCount; i += 1) {
          await submitOne(
            messageId,
            basePrompt,
            promptSummary,
            existing + i,
            1,
            'candidate_for_target',
          );
        }
      }
      toast.success(
        targetHasAsset ? `已提交 ${effectiveCount} 个候选` : '已提交生成，首个结果会填充目标节点',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成提交失败');
    } finally {
      setSending(false);
    }
  };

  if (!mediaTarget) {
    const isGeneratingTarget = target?.data.type === 'generation_placeholder';
    return (
      <div className="nodrag nopan flex h-full w-full items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm text-muted-foreground shadow-soft">
        {isGeneratingTarget ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
        <span className="truncate">{isGeneratingTarget ? '目标生成中' : '媒体目标不存在'}</span>
      </div>
    );
  }

  const Icon = mediaTarget.data.type === 'image' ? ImageIcon : Video;

  if (d.collapsed) {
    return (
      <button
        type="button"
        className={cn(
          'nodrag nopan flex h-full w-full items-center justify-between gap-2 rounded-xl border bg-card px-3 text-left shadow-soft transition-colors hover:bg-muted/60',
          selected ? 'border-accent' : 'border-border',
        )}
        onClick={() => setPanelCollapsed(false)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-accent" />
          <span className="truncate text-sm font-semibold">媒体对话</span>
        </span>
        <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div
      className={cn(
        'nodrag nopan flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card shadow-soft',
        selected ? 'border-accent' : 'border-border',
      )}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-accent" />
          <span className="truncate text-sm font-semibold">媒体对话</span>
        </div>
        <div className="flex items-center gap-1">
          <MessageSquare className="size-4 text-muted-foreground" />
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setPanelCollapsed(true)}
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          媒体描述
          <textarea
            value={mediaTarget.data.mediaDescription}
            onChange={(e) => updateDescription(e.target.value)}
            rows={3}
            className="resize-none rounded-lg border border-border bg-background px-2 py-2 text-sm font-normal text-foreground outline-none focus:ring-2 focus:ring-ring"
            placeholder="描述这张图片或这段视频本身"
          />
        </label>

        <div className="mt-3 rounded-lg border border-border p-2">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Settings2 className="size-3.5" />
            生成配置
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
              模型
              <select
                value={model?.key ?? ''}
                onChange={(e) => selectModel(e.target.value)}
                disabled={credentialsLoading || modelOptions.length === 0}
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
              >
                {modelOptions.length === 0 ? (
                  <option value="">
                    {credentialsLoading
                      ? '正在加载可用模型…'
                      : `没有可用的${mediaTarget.data.type === 'image' ? '图片' : '视频'}模型`}
                  </option>
                ) : null}
                {modelGroups.map((group) => (
                  <optgroup key={group.definition.id} label={group.definition.name}>
                    {group.models.map((option) => (
                      <option
                        key={option.key}
                        value={option.key}
                        disabled={option.capabilities.requiresReferenceImages && !referenceAssetId}
                      >
                        {option.displayName}
                        {option.capabilities.requiresReferenceImages && !referenceAssetId
                          ? '（需要输入素材）'
                          : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {!credentialsLoading && modelOptions.length === 0 ? (
                <span className="text-[11px] leading-relaxed text-danger">
                  请先在设置中配置并启用包含该类型模型的提供商
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              数量
              <input
                type="number"
                min={1}
                max={model?.capabilities.maxOutputs ?? 1}
                value={effectiveCount}
                onChange={(e) => updateSettings({ count: Number(e.target.value) || 1 })}
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              比例
              <select
                value={effectiveAspectRatio ?? ''}
                onChange={(e) =>
                  mediaTarget.data.type === 'image'
                    ? updateImageAspectRatio(e.target.value as AspectRatio)
                    : updateSettings({ aspectRatio: e.target.value as AspectRatio })
                }
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
              >
                {aspectRatioOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            {mediaTarget.data.type === 'image' ? (
              <>
                <label className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
                  尺寸预设
                  <select
                    value={settings.sizePreset ?? '1k'}
                    onChange={(e) => updateImageSizePreset(e.target.value as ImageSizePreset)}
                    className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
                  >
                    {IMAGE_SIZE_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                {settings.sizePreset === 'custom' ? (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      自定义宽度
                      <input
                        type="number"
                        min={64}
                        value={settings.width ?? ''}
                        onChange={(e) =>
                          updateSettings({
                            width: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                        className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      自定义高度
                      <input
                        type="number"
                        min={64}
                        value={settings.height ?? ''}
                        onChange={(e) =>
                          updateSettings({
                            height: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                        className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
                      />
                    </label>
                  </>
                ) : null}
                <label className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground">
                  质量
                  <select
                    value={settings.quality ?? ''}
                    onChange={(e) =>
                      updateSettings({
                        quality: e.target.value ? (e.target.value as ImageQuality) : undefined,
                      })
                    }
                    className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
                  >
                    <option value="">默认</option>
                    {qualityOptions.map((q) => (
                      <option key={q} value={q}>
                        {q}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  时长
                  <input
                    type="number"
                    min={model?.capabilities.videoDurationRange?.min ?? 1}
                    max={model?.capabilities.videoDurationRange?.max}
                    value={effectiveVideoDuration}
                    onChange={(e) => updateSettings({ durationSec: Number(e.target.value) || 5 })}
                    className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  分辨率
                  <select
                    value={effectiveVideoResolution}
                    onChange={(e) => updateSettings({ resolution: e.target.value })}
                    className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none"
                  >
                    {videoResolutionOptions.length > 0 ? (
                      videoResolutionOptions.map((resolution) => (
                        <option key={resolution} value={resolution}>
                          {resolution}
                        </option>
                      ))
                    ) : (
                      <option value={settings.resolution ?? '720p'}>
                        {settings.resolution ?? '720p'}
                      </option>
                    )}
                  </select>
                </label>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {messages.length === 0 ? (
            <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              {mediaTarget.data.assetId
                ? '输入流程要求，生成结果会作为候选留在目标旁边。'
                : '输入流程要求，首个结果会填充当前目标，额外结果会作为候选留在旁边。'}
            </div>
          ) : (
            messages.map((message) => <MessageRowView key={message.id} message={message} />)
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-background px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="流程要求，例如：生成同类型 5 张，背景更干净"
        />
        <Button
          size="sm"
          className="mt-2 w-full"
          onClick={() => void handleSend()}
          disabled={!model || sending}
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {mediaTarget.data.assetId ? '生成候选' : '生成目标'}
        </Button>
      </div>
    </div>
  );
}

/** 记忆化媒体侧卡节点。 */
export const MediaPanelNode = memo(MediaPanelNodeComponent);
