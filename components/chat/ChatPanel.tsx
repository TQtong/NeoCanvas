'use client';

/**
 * 对话面板容器（第 04 篇第三节）。
 *
 * 设计页右侧的对话区：顶部标题与「新对话 / 分享」控件，主体在无消息时居中展示引导大
 * 标题、有消息时渲染消息流，底部挂载输入条。本组件只负责布局与编排，发送逻辑由
 * {@link ChatInput} 与领域 hook 承担。
 *
 * @module components/chat/ChatPanel
 */

import { MessageSquarePlus, Share2 } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useTranslation } from '@/i18n';
import { IconButton } from '@/components/ui/icon-button';
import { useToast } from '@/components/ui/toast';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

/** {@link ChatPanel} 属性。 */
export interface ChatPanelProps {
  /** 当前项目标识，向下透传给输入条以驱动发送。 */
  projectId: string;
}

/**
 * 对话面板组件。
 *
 * @param props - 组件属性
 * @param props.projectId - 当前项目标识
 * @returns 右侧对话面板
 */
export function ChatPanel({ projectId }: ChatPanelProps) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  // 仅订阅是否为空，避免随每条增量重渲染容器
  const isEmpty = useChatStore((s) => s.messages.length === 0);

  // 新对话：在当前项目下建一条新会话并切换（清空消息流，保留所选模型 / 模式）
  const handleNewConversation = async () => {
    const { data, error } = await getBrowserSupabase()
      .from('conversations')
      .insert({ project_id: projectId })
      .select('id')
      .single();
    if (error || !data) {
      toastError(error?.message ?? t('error.internal_error'));
      return;
    }
    useChatStore.getState().startConversation(data.id);
    success(t('design.newConversationStarted'));
  };

  // 分享：复制当前页地址到剪贴板
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      success(t('common.linkCopied'));
    } catch {
      toastError(t('common.share'));
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 顶栏：标题 + 新对话 / 分享 */}
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('chat.newConversation')}</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label={t('chat.newConversation')}
            onClick={() => void handleNewConversation()}
          >
            <MessageSquarePlus />
          </IconButton>
          <IconButton size="sm" label={t('common.share')} onClick={() => void handleShare()}>
            <Share2 />
          </IconButton>
        </div>
      </header>

      {/* 主体：空态居中引导，否则消息流 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center px-6">
            <h1 className="max-w-sm text-balance text-center text-2xl font-semibold tracking-tight text-foreground">
              {t('chat.heading')}
            </h1>
          </div>
        ) : (
          <MessageList />
        )}
      </div>

      {/* 底部输入条 */}
      <div className="shrink-0">
        <ChatInput projectId={projectId} />
      </div>
    </div>
  );
}
