'use client';

/**
 * 设计页客户端工作台（第 04 篇第二、十一节）。
 *
 * 以服务端预取快照水合画布与对话状态库、建立 Realtime 订阅与持久化控制器，组合顶栏、
 * 无限画布、底部工具栏、左下控件与右侧对话面板。之后的一切交互与同步都在客户端发生。
 *
 * @module app/p/[projectId]/DesignWorkbench
 */

import { useCallback, useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { ModelCatalogEntry } from '@/types';
import type { ProjectBundle } from '@/lib/data/load-project';
import { useCanvasStore } from '@/stores/canvas-store';
import { useSessionStore } from '@/stores/session-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAsset } from '@/lib/storage/upload';
import { useCanvasPersistence } from '@/lib/hooks/use-canvas-persistence';
import { useRealtimeProject } from '@/lib/hooks/use-realtime-project';
import { useCanvasMedia } from '@/lib/hooks/use-canvas-media';
import { useSequenceVideo } from '@/lib/hooks/use-sequence-video';
import { resolveSequenceChain } from '@/lib/canvas/sequence';
import {
  createCanvasNode,
  createMediaTargetWithPanelNodes,
  type FlowPoint,
} from '@/lib/canvas/media-workflow';
import { CanvasContainer } from '@/components/canvas/CanvasContainer';
import { CanvasBottomToolbar } from '@/components/canvas/CanvasBottomToolbar';
import { CanvasCornerControls } from '@/components/canvas/CanvasCornerControls';
import { useCanvasHistory } from '@/components/canvas/use-canvas-history';
import { useCanvasShortcuts } from '@/components/canvas/use-canvas-shortcuts';
import { TopBar } from '@/components/shared/TopBar';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';

/** 工作台属性。 */
export interface DesignWorkbenchProps {
  /** 服务端预取的初始数据包。 */
  bundle: ProjectBundle;
  /** 模型目录。 */
  models: ModelCatalogEntry[];
}

/** 工作台内层（已处于 ReactFlowProvider 内，可用 useReactFlow）。 */
function WorkbenchInner({ bundle, models }: DesignWorkbenchProps) {
  const reactFlow = useReactFlow();
  const toast = useToast();
  const { t } = useTranslation();
  const { generate: generateSequenceVideo } = useSequenceVideo();
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingUploadPositionRef = useRef<FlowPoint | null>(null);

  const userId = useSessionStore((s) => s.profile?.id ?? bundle.project.owner_id);
  const title = useCanvasStore((s) => s.projectId) ? bundle.project.title : bundle.project.title;

  // 持久化、实时、媒体解析
  useCanvasPersistence(bundle.project.id, userId, (msg) => toast.error(msg));
  useRealtimeProject(bundle.project.id);
  useCanvasMedia(bundle.project.id);

  // 撤销 / 重做与快捷键
  const history = useCanvasHistory(bundle.project.id);
  useCanvasShortcuts(history);

  // 上传媒体工具：选文件 → 上传 → 在视口中心落图片 / 视频节点（按资产种类分支）
  const onUploadMedia = useCallback((position?: FlowPoint) => {
    pendingUploadPositionRef.current = position ?? null;
    fileRef.current?.click();
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        // 客户端直传到 uploads 私有桶并登记资产；kind 由 MIME 自动判定（图片 / 视频）
        const asset = await uploadAsset(getBrowserSupabase(), {
          file,
          userId,
          projectId: bundle.project.id,
        });
        // 依资产宽高按比例缩放到合适落位尺寸；缺尺寸时视频退回 16:9、图片退回 1:1
        const maxSide = asset.kind === 'video' ? 480 : 400;
        const fallbackRatio = asset.kind === 'video' ? 16 / 9 : 1;
        const ratio = asset.width && asset.height ? asset.width / asset.height : fallbackRatio;
        const width = ratio >= 1 ? maxSide : Math.round(maxSide * ratio);
        const height = ratio >= 1 ? Math.round(maxSide / ratio) : maxSide;
        const center =
          pendingUploadPositionRef.current ??
          reactFlow.screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          });
        pendingUploadPositionRef.current = null;
        // 共享落位字段：视口中心居中落点 + 尺寸 + 层级
        const position = { x: center.x - width / 2, y: center.y - height / 2 };
        // 运行时即注入签名 URL，让节点即刻可见；刷新后由 useCanvasMedia 按 assetId 重新解析
        const { target, panel } = createMediaTargetWithPanelNodes({
          modality: asset.kind === 'video' ? 'video' : 'image',
          position,
          size: { width, height },
          mediaData:
            asset.kind === 'video'
              ? {
                  assetId: asset.id,
                  src: asset.url,
                  posterSrc: asset.thumbnailUrl,
                }
              : {
                  assetId: asset.id,
                  src: asset.url,
                  thumbnailSrc: asset.thumbnailUrl,
                  naturalWidth: asset.width,
                  naturalHeight: asset.height,
                },
        });
        const store = useCanvasStore.getState();
        store.addNodes([target, panel], { select: false });
        store.setSelection([target.id]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '上传失败');
      } finally {
        pendingUploadPositionRef.current = null;
      }
    },
    [bundle.project.id, reactFlow, toast, userId],
  );

  // AI 工具：调起对应模态的生成。
  // 「AI 视频」特例：若当前恰好选中一条「序列链」上的成员（≥2 个已绑资产的媒体节点），直接按
  // 帧顺序生成——与节点悬浮工具栏入口行为一致，消除「连好图序列、点了底部视频按钮却没反应」的
  // 困惑。否则退回轻量提示词生成：切到该模态模型、置为「纯生成」模式，展开对话并聚焦提示词输入
  //（第 04 篇 4.9），提交后复用统一生成流水线。
  const onAiTool = useCallback(
    async (modality: 'image' | 'video' | 'text') => {
      if (modality === 'video') {
        const { nodes, edges, selectedNodeIds } = useCanvasStore.getState();
        const nodeId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : undefined;
        if (nodeId) {
          const node = nodes.find((n) => n.id === nodeId);
          const isMedia = node?.data.type === 'image' || node?.data.type === 'video';
          const boundCount = isMedia
            ? resolveSequenceChain(nodes, edges, nodeId).nodes.filter(
                (n) => (n.data.type === 'image' || n.data.type === 'video') && n.data.assetId,
              ).length
            : 0;
          if (boundCount >= 2) {
            const result = await generateSequenceVideo(nodeId);
            if (result.ok) toast.success(t('node.videoQueued'));
            else if (result.reason === 'too_short') toast.error(t('node.videoTooShort'));
            else if (result.reason === 'no_model') toast.error(t('node.videoNoModel'));
            else toast.error(t('node.videoFailed'));
            return;
          }
        }
      }

      const center = reactFlow.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const store = useCanvasStore.getState();
      const zIndex = Math.max(0, ...store.nodes.map((n) => n.zIndex ?? 0)) + 1;

      if (modality === 'text') {
        const node = createCanvasNode('text', { x: center.x - 120, y: center.y - 32 }, { zIndex });
        store.addNode(node, { select: true });
        store.setEditingNode(node.id);
        return;
      }

      const match = models.find((m) => m.modality === modality && m.isActive);
      const size = modality === 'video' ? { width: 480, height: 270 } : { width: 320, height: 320 };
      const { target, panel } = createMediaTargetWithPanelNodes({
        modality,
        position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
        size,
        zIndex,
        mediaData: {
          generationSettings: {
            modelKey: match?.key ?? null,
            count: 1,
            aspectRatio: match?.defaultParams.aspectRatio ?? (modality === 'video' ? '16:9' : '1:1'),
            sizePreset:
              modality === 'image' && match?.defaultParams.width && match.defaultParams.height
                ? 'custom'
                : modality === 'image'
                  ? '1k'
                  : undefined,
            width: match?.defaultParams.width,
            height: match?.defaultParams.height,
            quality: match?.defaultParams.quality,
            durationSec: match?.defaultParams.durationSec ?? (modality === 'video' ? 5 : undefined),
            resolution: match?.defaultParams.resolution ?? (modality === 'video' ? '720p' : undefined),
            fps: match?.defaultParams.fps ?? (modality === 'video' ? 24 : undefined),
            motionStrength: match?.defaultParams.motionStrength,
          },
        },
      });
      store.addNodes([target, panel], { select: false });
      store.setSelection([target.id]);
    },
    [models, generateSequenceVideo, reactFlow, t, toast],
  );

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-background">
      {/* 左侧画布区 */}
      <div className="relative flex-1">
        <TopBar projectId={bundle.project.id} title={title} />
        <div className="absolute inset-0 pt-14">
          <CanvasContainer
            initialViewport={bundle.project.viewport}
            onUploadMediaAt={onUploadMedia}
          />
        </div>
        <CanvasBottomToolbar onUploadMedia={() => onUploadMedia()} onAiTool={onAiTool} />
        <CanvasCornerControls />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

/**
 * 设计页工作台。以服务端快照水合状态库，卸载时重置。
 *
 * StrictMode 安全：开发期 React 会 mount→unmount→remount，下方 cleanup 的 reset() 会清空
 * 画布与对话状态库。若仅用一次性 ref 在渲染期水合，remount 后不会重灌，会留下空的
 * conversationId 与空画布——表现为「发送按钮可点但点击无反应（send 因 conversationId 为空提前
 * 返回）」「画布空白」。故除首帧同步水合（避免空闪、让子组件首次渲染即可读到状态）外，还在
 * effect 每次 setup 重新水合，使 remount（及切换项目）后状态库始终对应当前项目。
 */
export function DesignWorkbench({ bundle, models }: DesignWorkbenchProps) {
  // 在 effect 内水合两库、cleanup 重置：
  // - 不在渲染期调用 store.set()，避免「在渲染 DesignWorkbench 时更新订阅了画布库的子组件
  //   （AlignmentGuides 等）」的 setState-in-render 告警；
  // - StrictMode 下 dev 会 mount→unmount→remount，setup 重灌、cleanup 重置成对出现，remount
  //   后状态库仍对应当前项目（修复此前 conversationId 被清空致「发送无反应」、画布空白）；
  // - bundle 随服务端渲染稳定，切换项目时变更，届时自动「重置旧项目→水合新项目」。
  // effect 在首帧提交后随即运行（早于任何用户交互），故 send() 取用 conversationId 时已就绪。
  useEffect(() => {
    useCanvasStore.getState().hydrate({
      projectId: bundle.project.id,
      nodeRows: bundle.nodes,
      edgeRows: bundle.edges,
      viewport: bundle.project.viewport,
    });
    return () => {
      useCanvasStore.getState().reset();
    };
  }, [bundle]);

  return (
    <ReactFlowProvider>
      <WorkbenchInner bundle={bundle} models={models} />
    </ReactFlowProvider>
  );
}
