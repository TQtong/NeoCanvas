'use client';

/**
 * 节点浮动工具条（第 01 篇、第 04 篇组件清单）。
 *
 * 单选节点时在其上方浮现一条与元素类型相关的工具条：通用提供复制 / 置顶 / 置底 / 删除；
 * 图片 / 视频额外提供「以此为参考再生成」（提及该节点并聚焦对话）与「替换」；文本提供
 * 字号 / 颜色 / 对齐等排版属性；形状提供填充 / 描边。多选时由组变换层处理。
 *
 * @module components/canvas/NodeFloatingToolbar
 */

import { useRef, useState } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowLeftRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Clapperboard,
  Copy,
  Eye,
  EyeOff,
  Italic,
  MessageSquare,
  Replace,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Trash2,
  Underline,
  Ungroup,
} from 'lucide-react';
import type { NodeData, ShapeNodeData, TextAlign, TextNodeData } from '@/types';
import { useCanvasStore } from '@/stores/canvas-store';
import { useSessionStore } from '@/stores/session-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { resolveSequenceChain } from '@/lib/canvas/sequence';
import { collectGroupOverlays } from '@/lib/canvas/flatten';
import { nodeBox, type CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { createDefaultNodeData } from '@/lib/canvas/constants';
import { createCanvasNode } from '@/lib/canvas/media-workflow';
import { uuid } from '@/lib/utils/id';
import { useSequenceVideo } from '@/lib/hooks/use-sequence-video';
import { useRegenerateNode } from '@/lib/hooks/use-regenerate-node';
import { useRegeneratePoster } from '@/lib/hooks/use-regenerate-poster';
import { useSwapMediaCandidate } from '@/lib/hooks/use-swap-media-candidate';
import { uploadAsset } from '@/lib/storage/upload';
import { IconButton } from '@/components/ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';

const MEDIA_PANEL_GAP = 24;
const MEDIA_PANEL_EXPANDED_HEIGHT = 560;
const FLOATING_TOOLBAR_Z_INDEX = 2_147_483_647;

/** 沿候选链找到真正的根主媒体，支持“候选的候选”替换根目标。 */
function resolveRootPrimaryNodeId(
  nodes: CanvasFlowNode[],
  candidateNode: CanvasFlowNode,
): string | null {
  if (candidateNode.data.type !== 'image' && candidateNode.data.type !== 'video') return null;
  let ownerId = candidateNode.data.candidateOf;
  if (!ownerId) return null;

  const visited = new Set<string>([candidateNode.id]);
  while (ownerId && !visited.has(ownerId)) {
    const owner = nodes.find((n) => n.id === ownerId);
    if (!owner || (owner.data.type !== 'image' && owner.data.type !== 'video')) {
      return ownerId;
    }
    if (!owner.data.candidateOf) return owner.id;
    visited.add(owner.id);
    ownerId = owner.data.candidateOf;
  }

  return candidateNode.data.candidateOf;
}

/** 文本属性子面板。 */
function TextProperties({ id, data }: { id: string; data: TextNodeData }) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const aligns: Array<{ value: TextAlign; icon: typeof AlignLeft }> = [
    { value: 'left', icon: AlignLeft },
    { value: 'center', icon: AlignCenter },
    { value: 'right', icon: AlignRight },
  ];
  return (
    <div className="flex w-60 flex-col gap-3 p-1">
      <label className="flex items-center justify-between gap-2 text-sm">
        字号
        <input
          type="number"
          min={8}
          max={200}
          value={data.fontSize}
          onChange={(e) => updateNodeData(id, { fontSize: Number(e.target.value) })}
          className="h-8 w-20 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        颜色
        <input
          type="color"
          value={data.color.startsWith('#') ? data.color : '#1a1a1f'}
          onChange={(e) => updateNodeData(id, { color: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-background"
        />
      </label>
      <div className="flex items-center gap-1">
        {aligns.map(({ value, icon: Icon }) => (
          <IconButton
            key={value}
            size="sm"
            label={value}
            active={data.align === value}
            onClick={() => updateNodeData(id, { align: value })}
          >
            <Icon />
          </IconButton>
        ))}
        <div className="mx-1 h-5 w-px bg-border" />
        <IconButton
          size="sm"
          label="加粗"
          active={data.fontWeight >= 600}
          onClick={() => updateNodeData(id, { fontWeight: data.fontWeight >= 600 ? 400 : 700 })}
        >
          <Bold />
        </IconButton>
        <IconButton
          size="sm"
          label="斜体"
          active={data.italic}
          onClick={() => updateNodeData(id, { italic: !data.italic })}
        >
          <Italic />
        </IconButton>
        <IconButton
          size="sm"
          label="下划线"
          active={data.underline}
          onClick={() => updateNodeData(id, { underline: !data.underline })}
        >
          <Underline />
        </IconButton>
      </div>
    </div>
  );
}

/** 形状属性子面板。 */
function ShapeProperties({ id, data }: { id: string; data: ShapeNodeData }) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  return (
    <div className="flex w-52 flex-col gap-3 p-1">
      <label className="flex items-center justify-between gap-2 text-sm">
        填充
        <input
          type="color"
          value={data.fill.startsWith('#') ? data.fill : '#7c3aed'}
          onChange={(e) => updateNodeData(id, { fill: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-background"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        描边
        <input
          type="color"
          value={data.stroke.startsWith('#') ? data.stroke : '#7c3aed'}
          onChange={(e) => updateNodeData(id, { stroke: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded-lg border border-border bg-background"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        描边宽
        <input
          type="number"
          min={0}
          max={40}
          value={data.strokeWidth}
          onChange={(e) => updateNodeData(id, { strokeWidth: Number(e.target.value) })}
          className="h-8 w-20 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
    </div>
  );
}

/**
 * 节点浮动工具条。须置于 ReactFlowProvider 内。
 */
export interface NodeFloatingToolbarProps {
  /** 打开图片精准编辑器。 */
  onEditImage?: (nodeId: string) => void;
}

export function NodeFloatingToolbar({ onEditImage }: NodeFloatingToolbarProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const deleteHandledAtRef = useRef(0);
  // 再生成在途标记：防连点重复提交（避免重复背景任务与重复文字节点）
  const [regenPending, setRegenPending] = useState(false);
  const [swapPending, setSwapPending] = useState(false);

  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const duplicateSelection = useCanvasStore((s) => s.duplicateSelection);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const sendToBack = useCanvasStore((s) => s.sendToBack);
  const updateNode = useCanvasStore((s) => s.updateNode);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const addNode = useCanvasStore((s) => s.addNode);
  const addAnnotationEdge = useCanvasStore((s) => s.addAnnotationEdge);
  const setEditingNode = useCanvasStore((s) => s.setEditingNode);
  const setSelection = useCanvasStore((s) => s.setSelection);
  const ungroupSelection = useCanvasStore((s) => s.ungroupSelection);
  const projectId = useCanvasStore((s) => s.projectId);

  const profile = useSessionStore((s) => s.profile);
  const { generate: generateSequenceVideo } = useSequenceVideo();
  const { regenerate } = useRegenerateNode();
  const { regeneratePoster } = useRegeneratePoster();
  const { swap } = useSwapMediaCandidate();

  if (selectedNodeIds.length !== 1) return null;
  const node = nodes.find((n) => n.id === selectedNodeIds[0]);
  if (!node) return null;

  const mediaData = node.data.type === 'image' || node.data.type === 'video' ? node.data : null;
  const isMedia = Boolean(mediaData);
  const candidateOf = mediaData?.candidateOf ?? null;
  const isCandidate = mediaData?.mediaRole === 'candidate' && Boolean(candidateOf);
  const primaryCandidateNodeId =
    isCandidate && mediaData ? resolveRootPrimaryNodeId(nodes, node) : null;
  const candidateCount = mediaData
    ? nodes.filter((n) => {
        if (n.data.type === 'image' || n.data.type === 'video') {
          return n.data.candidateOf === node.id;
        }
        if (n.data.type === 'generation_placeholder') {
          return n.data.resultMode === 'candidate_for_target' && n.data.targetNodeId === node.id;
        }
        return false;
      }).length
    : 0;

  // 选中节点处于一条「序列链」（≥2 个已绑定资产的媒体成员）时，提供「按顺序生成视频」
  const canGenerateVideo =
    isMedia &&
    resolveSequenceChain(nodes, edges, node.id).nodes.filter(
      (n) => (n.data.type === 'image' || n.data.type === 'video') && n.data.assetId,
    ).length >= 2;

  const onGenerateVideo = async () => {
    const result = await generateSequenceVideo(node.id);
    if (result.ok) {
      toast.success(t('node.videoQueued'));
      return;
    }
    if (result.reason === 'too_short') toast.error(t('node.videoTooShort'));
    else if (result.reason === 'no_model') toast.error(t('node.videoNoModel'));
    else {
      // 失败详情仅入控制台便于排查；用户侧统一走已本地化文案，避免原始（可能中文）message 串到英文界面
      if (result.message) {
        // eslint-disable-next-line no-console
        console.error('序列视频生成失败', result.message);
      }
      toast.error(t('node.videoFailed'));
    }
  };

  // 「以此为参考再生成」：一键以选中节点为视觉参考，原地生成相似内容并替换选中节点本身。
  // 分流：选中的是「成组海报」（图片 + 同组文字/形状叠层）→ 整组重新编排（新背景 + 新可编辑
  // 文字，整组替换）；否则单节点图生图 / 图生视频相似变体。
  const onRegenerate = async () => {
    if (regenPending) return; // 连点保护：在途时忽略后续点击
    setRegenPending(true);
    try {
      const overlays = node.data.type === 'image' ? collectGroupOverlays(nodes, node) : [];
      const isPosterGroup = Boolean(node.data.groupId) && overlays.length > 0;

      const result = isPosterGroup ? await regeneratePoster(node.id) : await regenerate(node.id);
      if (result.ok) {
        toast.success(isPosterGroup ? t('node.regenPosterStarted') : t('node.regenStarted'));
        return;
      }
      if (result.reason === 'no_asset') toast.error(t('node.regenNoAsset'));
      else if (result.reason === 'no_model') {
        toast.error(
          node.data.type === 'video' ? t('node.regenNoVideoModel') : t('node.regenNoRefModel'),
        );
      } else {
        // 失败详情仅入控制台便于排查；用户侧统一走已本地化文案
        if (result.message) {
          // eslint-disable-next-line no-console
          console.error('相似再生成失败', result.message);
        }
        toast.error(t('node.regenFailed'));
      }
    } finally {
      setRegenPending(false);
    }
  };

  const onSwapCandidate = async () => {
    if (!projectId || !primaryCandidateNodeId || swapPending) return;
    const primaryBefore = nodes.find((n) => n.id === primaryCandidateNodeId);
    const candidateBefore = node;
    const candidateIndex =
      mediaData && 'candidateIndex' in mediaData ? mediaData.candidateIndex : null;
    if (
      !primaryBefore ||
      (primaryBefore.data.type !== 'image' && primaryBefore.data.type !== 'video') ||
      (candidateBefore.data.type !== 'image' && candidateBefore.data.type !== 'video')
    ) {
      return;
    }
    setSwapPending(true);
    try {
      const geometryMode =
        candidateBefore.data.sourceOperation === 'outpaint'
          ? 'adopt_output_geometry'
          : 'preserve_frame';
      await swap({
        projectId,
        primaryNodeId: primaryCandidateNodeId,
        candidateNodeId: node.id,
        geometryMode,
      });
      const store = useCanvasStore.getState();
      const latestPrimary = store.nodes.find((n) => n.id === primaryCandidateNodeId);
      const latestCandidate = store.nodes.find((n) => n.id === node.id);
      const stillWaitingForRealtime =
        latestPrimary?.data.type === primaryBefore.data.type &&
        latestCandidate?.data.type === candidateBefore.data.type &&
        (latestPrimary.data.type === 'image' || latestPrimary.data.type === 'video') &&
        latestPrimary.data.assetId === primaryBefore.data.assetId &&
        (latestCandidate.data.type === 'image' || latestCandidate.data.type === 'video') &&
        latestCandidate.data.assetId === candidateBefore.data.assetId;

      if (latestPrimary && latestCandidate && stillWaitingForRealtime) {
        const primaryData = {
          ...candidateBefore.data,
          mediaRole: 'primary',
          candidateOf: null,
          candidateIndex: null,
        } as NodeData;
        const candidateData = {
          ...primaryBefore.data,
          mediaRole: 'candidate',
          candidateOf: primaryCandidateNodeId,
          candidateIndex,
        } as NodeData;

        if (geometryMode === 'adopt_output_geometry') {
          const primaryBox = nodeBox(primaryBefore);
          const candidateBox = nodeBox(candidateBefore);
          const centerX = primaryBox.x + primaryBox.width / 2;
          const centerY = primaryBox.y + primaryBox.height / 2;
          store.replaceNode(
            primaryCandidateNodeId,
            {
              ...latestPrimary,
              type: candidateBefore.type,
              position: {
                x: centerX - candidateBox.width / 2,
                y: centerY - candidateBox.height / 2,
              },
              width: candidateBox.width,
              height: candidateBox.height,
              style: {
                ...latestPrimary.style,
                width: candidateBox.width,
                height: candidateBox.height,
              },
              data: primaryData,
            },
            { persist: false },
          );
          store.replaceNode(
            node.id,
            {
              ...latestCandidate,
              type: primaryBefore.type,
              position: { x: primaryBox.x, y: primaryBox.y },
              width: primaryBox.width,
              height: primaryBox.height,
              style: {
                ...latestCandidate.style,
                width: primaryBox.width,
                height: primaryBox.height,
              },
              data: candidateData,
            },
            { persist: false },
          );
        } else {
          store.replaceNode(
            primaryCandidateNodeId,
            { ...latestPrimary, type: candidateBefore.type, data: primaryData },
            { persist: false },
          );
          store.replaceNode(
            node.id,
            { ...latestCandidate, type: primaryBefore.type, data: candidateData },
            { persist: false },
          );
        }
      }
      toast.success('已替换主媒体');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '替换主媒体失败');
    } finally {
      setSwapPending(false);
    }
  };

  const onOpenMediaPanel = () => {
    if (!isMedia) return;
    const box = nodeBox(node);
    const panelPosition = { x: box.x, y: box.y + box.height + MEDIA_PANEL_GAP };
    const existing = nodes.find(
      (n) => n.data.type === 'media_panel' && n.data.targetNodeId === node.id,
    );
    if (existing) {
      updateNode(existing.id, {
        position: panelPosition,
        width: box.width,
        height: MEDIA_PANEL_EXPANDED_HEIGHT,
        style: { width: box.width, height: MEDIA_PANEL_EXPANDED_HEIGHT },
      });
      updateNodeData(existing.id, { collapsed: false });
      bringToFront([existing.id]);
      setSelection([existing.id]);
      return;
    }
    const zIndex = Math.max(0, ...nodes.map((n) => n.zIndex ?? 0)) + 1;
    addNode(
      createCanvasNode('media_panel', panelPosition, {
        size: { width: box.width, height: MEDIA_PANEL_EXPANDED_HEIGHT },
        zIndex,
        data: { targetNodeId: node.id, collapsed: false },
      }),
      { select: true },
    );
  };

  const onToggleCandidates = () => {
    if (!mediaData) return;
    updateNodeData(node.id, { candidatesCollapsed: !mediaData.candidatesCollapsed });
  };

  /** 删除当前节点；画板下方仍有重叠画板时选中下一层，避免视觉上误以为删除失败。 */
  const onDeleteNode = () => {
    const now = Date.now();
    if (now - deleteHandledAtRef.current < 500) return;
    deleteHandledAtRef.current = now;

    const selectedBox = nodeBox(node);
    const overlappingFrames =
      node.data.type === 'frame'
        ? nodes
            .filter((candidate) => {
              if (candidate.id === node.id || candidate.data.type !== 'frame') return false;
              const candidateBox = nodeBox(candidate);
              return (
                selectedBox.x < candidateBox.x + candidateBox.width &&
                selectedBox.x + selectedBox.width > candidateBox.x &&
                selectedBox.y < candidateBox.y + candidateBox.height &&
                selectedBox.y + selectedBox.height > candidateBox.y
              );
            })
            .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))
        : [];

    removeNodes([node.id]);
    if (node.data.type !== 'frame') return;

    const nextFrame = overlappingFrames[0];
    if (nextFrame) {
      setSelection([nextFrame.id]);
      toast.info(`已删除当前画板；下方还有 ${overlappingFrames.length} 个重叠画板`);
    } else {
      toast.success('画板已删除');
    }
  };

  // 添加描述：在图片上方落一个文字便签，自动连一条「描述」边并进入编辑
  const onAddDescription = () => {
    const box = nodeBox(node);
    const noteWidth = 240;
    const noteHeight = 88;
    const noteId = uuid();
    const note: CanvasFlowNode = {
      id: noteId,
      type: 'text',
      position: { x: box.x, y: box.y - noteHeight - 24 },
      data: createDefaultNodeData('text', {
        text: '',
        fontSize: 14,
        backgroundColor: 'hsl(48 95% 90%)',
      }),
      width: noteWidth,
      height: noteHeight,
      zIndex: 0,
      style: { width: noteWidth, height: noteHeight },
    };
    addNode(note, { select: true });
    addAnnotationEdge(noteId, node.id);
    setEditingNode(noteId);
  };

  const onReplaceFile = async (file: File) => {
    if (!profile) return;
    try {
      const asset = await uploadAsset(getBrowserSupabase(), {
        file,
        userId: profile.id,
        projectId,
      });
      updateNodeData(node.id, {
        assetId: asset.id,
        src: asset.url,
        thumbnailSrc: asset.thumbnailUrl,
        naturalWidth: asset.width,
        naturalHeight: asset.height,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '替换失败');
    }
  };

  return (
    <NodeToolbar
      nodeId={node.id}
      isVisible
      position={Position.Top}
      offset={12}
      style={{ zIndex: FLOATING_TOOLBAR_Z_INDEX }}
    >
      <div
        className="nodrag nopan glass pointer-events-auto flex items-center gap-0.5 rounded-xl p-1"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {isMedia ? (
          <>
            {isCandidate ? (
              <Tooltip content="替换主媒体">
                <IconButton
                  size="sm"
                  label="替换主媒体"
                  className="text-accent"
                  disabled={swapPending}
                  onClick={() => void onSwapCandidate()}
                >
                  <ArrowLeftRight />
                </IconButton>
              </Tooltip>
            ) : null}
            {isMedia ? (
              <Tooltip content="媒体对话">
                <IconButton size="sm" label="媒体对话" onClick={onOpenMediaPanel}>
                  <MessageSquare />
                </IconButton>
              </Tooltip>
            ) : null}
            {candidateCount > 0 && mediaData ? (
              <Tooltip content={mediaData.candidatesCollapsed ? '展开候选' : '收起候选'}>
                <IconButton
                  size="sm"
                  label={mediaData.candidatesCollapsed ? '展开候选' : '收起候选'}
                  onClick={onToggleCandidates}
                >
                  {mediaData.candidatesCollapsed ? <Eye /> : <EyeOff />}
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip content={t('node.regenerate')}>
              <IconButton
                size="sm"
                label={t('node.regenerate')}
                className="text-accent"
                disabled={regenPending}
                onClick={() => void onRegenerate()}
              >
                <Sparkles />
              </IconButton>
            </Tooltip>
            {node.data.type === 'image' && node.data.assetId && node.data.src && onEditImage ? (
              <Tooltip content={t('node.precisionEdit')}>
                <IconButton
                  size="sm"
                  label={t('node.precisionEdit')}
                  className="text-accent"
                  onClick={() => onEditImage(node.id)}
                >
                  <SlidersHorizontal />
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip content={t('node.replace')}>
              <IconButton
                size="sm"
                label={t('node.replace')}
                onClick={() => fileRef.current?.click()}
              >
                <Replace />
              </IconButton>
            </Tooltip>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onReplaceFile(file);
                e.target.value = '';
              }}
            />
            <Tooltip content={t('node.addDescription')}>
              <IconButton size="sm" label={t('node.addDescription')} onClick={onAddDescription}>
                <StickyNote />
              </IconButton>
            </Tooltip>
            {canGenerateVideo ? (
              <Tooltip content={t('node.generateVideo')}>
                <IconButton
                  size="sm"
                  label={t('node.generateVideo')}
                  className="text-accent"
                  onClick={() => void onGenerateVideo()}
                >
                  <Clapperboard />
                </IconButton>
              </Tooltip>
            ) : null}
            <div className="mx-0.5 h-5 w-px bg-border" />
          </>
        ) : null}

        {node.data.type === 'text' ? (
          <Popover>
            <PopoverTrigger asChild>
              <button className="rounded-md px-2 py-1 text-sm font-medium text-foreground hover:bg-muted">
                Aa
              </button>
            </PopoverTrigger>
            <PopoverContent side="top">
              <TextProperties id={node.id} data={node.data as TextNodeData} />
            </PopoverContent>
          </Popover>
        ) : null}

        {node.data.type === 'shape' ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="size-7 rounded-md border border-border"
                style={{ background: (node.data as ShapeNodeData).fill }}
                aria-label="形状属性"
              />
            </PopoverTrigger>
            <PopoverContent side="top">
              <ShapeProperties id={node.id} data={node.data as ShapeNodeData} />
            </PopoverContent>
          </Popover>
        ) : null}

        {/* 解组：逻辑组成员（groupId）或 parent_id 容器/子节点（历史海报 / 画板）单选时均可解组 */}
        {node.data.groupId || nodes.some((n) => n.parentId === node.id) || node.parentId ? (
          <Tooltip content={t('node.ungroup')}>
            <IconButton size="sm" label={t('node.ungroup')} onClick={() => ungroupSelection()}>
              <Ungroup />
            </IconButton>
          </Tooltip>
        ) : null}

        <Tooltip content={t('node.duplicate')}>
          <IconButton size="sm" label={t('node.duplicate')} onClick={() => duplicateSelection()}>
            <Copy />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('node.bringToFront')}>
          <IconButton
            size="sm"
            label={t('node.bringToFront')}
            onClick={() => bringToFront([node.id])}
          >
            <ArrowUpToLine />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('node.sendToBack')}>
          <IconButton size="sm" label={t('node.sendToBack')} onClick={() => sendToBack([node.id])}>
            <ArrowDownToLine />
          </IconButton>
        </Tooltip>
        {node.data.type === 'media_panel' ? null : (
          <Tooltip content={t('node.delete')}>
            <IconButton
              size="sm"
              label={t('node.delete')}
              className="nodrag nopan hover:text-danger"
              onPointerDown={(event) => {
                // 在 React Flow 处理选中状态前完成删除，避免 pointerdown 后节点状态变化吞掉 click。
                event.preventDefault();
                event.stopPropagation();
                onDeleteNode();
              }}
              onClick={(event) => {
                // 非 PointerEvent 环境的兜底；正常浏览器会在 pointerdown 时完成删除。
                event.preventDefault();
                event.stopPropagation();
                onDeleteNode();
              }}
            >
              <Trash2 />
            </IconButton>
          </Tooltip>
        )}
      </div>
    </NodeToolbar>
  );
}
