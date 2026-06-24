'use client';

/**
 * 设计页客户端工作台（第 04 篇第二、十一节）。
 *
 * 以服务端预取快照水合画布与对话状态库、建立 Realtime 订阅与持久化控制器，组合顶栏、
 * 无限画布、底部工具栏、左下控件与右侧对话面板。之后的一切交互与同步都在客户端发生。
 *
 * @module app/p/[projectId]/DesignWorkbench
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { ModelCatalogEntry } from '@/types';
import type { ProjectBundle } from '@/lib/data/load-project';
import { useCanvasStore } from '@/stores/canvas-store';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { messageRowToView } from '@/lib/data/mappers';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { uploadAsset } from '@/lib/storage/upload';
import { useCanvasPersistence } from '@/lib/hooks/use-canvas-persistence';
import { useRealtimeProject } from '@/lib/hooks/use-realtime-project';
import { useCanvasMedia } from '@/lib/hooks/use-canvas-media';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { uuid } from '@/lib/utils/id';
import { createDefaultNodeData } from '@/lib/canvas/constants';
import { CanvasContainer } from '@/components/canvas/CanvasContainer';
import { CanvasBottomToolbar } from '@/components/canvas/CanvasBottomToolbar';
import { CanvasCornerControls } from '@/components/canvas/CanvasCornerControls';
import { useCanvasHistory } from '@/components/canvas/use-canvas-history';
import { useCanvasShortcuts } from '@/components/canvas/use-canvas-shortcuts';
import { TopBar } from '@/components/shared/TopBar';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';

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
  const fileRef = useRef<HTMLInputElement>(null);

  const userId = useSessionStore((s) => s.profile?.id ?? bundle.project.owner_id);
  const [panelOpen, setPanelOpen] = useState(true);
  const title = useCanvasStore((s) => s.projectId) ? bundle.project.title : bundle.project.title;

  const conversationId = bundle.conversation?.id ?? null;

  // 持久化、实时、媒体解析
  useCanvasPersistence(bundle.project.id, userId, (msg) => toast.error(msg));
  useRealtimeProject(bundle.project.id, conversationId);
  useCanvasMedia(bundle.project.id);

  // 撤销 / 重做与快捷键
  const history = useCanvasHistory(bundle.project.id);
  useCanvasShortcuts(history);

  // 上传图片工具：选文件 → 上传 → 在视口中心落图片节点
  const onUploadImage = useCallback(() => fileRef.current?.click(), []);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const asset = await uploadAsset(getBrowserSupabase(), {
          file,
          userId,
          projectId: bundle.project.id,
        });
        const maxSide = 400;
        const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
        const width = ratio >= 1 ? maxSide : Math.round(maxSide * ratio);
        const height = ratio >= 1 ? Math.round(maxSide / ratio) : maxSide;
        const center = reactFlow.screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
        const node: CanvasFlowNode = {
          id: uuid(),
          type: 'image',
          position: { x: center.x - width / 2, y: center.y - height / 2 },
          data: createDefaultNodeData('image', {
            assetId: asset.id,
            src: asset.url,
            thumbnailSrc: asset.thumbnailUrl,
            naturalWidth: asset.width,
            naturalHeight: asset.height,
          }),
          width,
          height,
          zIndex: 0,
          style: { width, height },
        };
        useCanvasStore.getState().addNode(node, { select: true });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '上传失败');
      }
    },
    [bundle.project.id, reactFlow, toast, userId],
  );

  // AI 工具：调起对应模态的生成——切到该模态模型、置为「纯生成」模式，展开对话并聚焦提示词
  // 输入（第 04 篇 4.9 的「唤起轻量提示词输入再提交」一途），提交后复用统一生成流水线。
  const onAiTool = useCallback(
    (modality: 'image' | 'video' | 'text') => {
      const match = models.find((m) => m.modality === modality) ?? models[0];
      const chat = useChatStore.getState();
      if (match) chat.setModel(match.key);
      chat.setAgentMode('generate');
      setPanelOpen(true);
      chat.requestFocus();
    },
    [models],
  );

  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-background">
      {/* 左侧画布区 */}
      <div className="relative flex-1">
        <TopBar
          projectId={bundle.project.id}
          title={title}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((v) => !v)}
        />
        <div className="absolute inset-0 pt-14">
          <CanvasContainer initialViewport={bundle.project.viewport} />
        </div>
        <CanvasBottomToolbar onUploadImage={onUploadImage} onAiTool={onAiTool} />
        <CanvasCornerControls />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* 右侧对话面板（可收起） */}
      <aside
        className={cn(
          'h-full shrink-0 border-l border-border bg-card transition-[width] duration-300',
          panelOpen ? 'w-[380px]' : 'w-0 overflow-hidden border-l-0',
        )}
      >
        {panelOpen ? <ChatPanel projectId={bundle.project.id} /> : null}
      </aside>
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
    useChatStore.getState().hydrate({
      conversationId: bundle.conversation?.id ?? '',
      messages: bundle.messages.map(messageRowToView),
      selectedModelKey: bundle.project.default_model_key,
      agentMode: 'generate',
      hasMoreMessages: bundle.hasMoreMessages,
    });
    return () => {
      useCanvasStore.getState().reset();
      useChatStore.getState().reset();
    };
  }, [bundle]);

  return (
    <ReactFlowProvider>
      <WorkbenchInner bundle={bundle} models={models} />
    </ReactFlowProvider>
  );
}
