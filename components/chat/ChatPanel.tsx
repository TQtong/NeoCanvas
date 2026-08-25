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

import { Check, ChevronDown, MessageSquarePlus, PanelRightClose, Share2 } from 'lucide-react';
import { useState } from 'react';
import type { ConversationRow, ModelCatalogEntry } from '@/types';
import { useChatStore } from '@/stores/chat-store';
import { MESSAGES_PAGE_SIZE, isRenderableMessage } from '@/lib/data/mappers';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { useTranslation } from '@/i18n';
import { IconButton } from '@/components/ui/icon-button';
import { useToast } from '@/components/ui/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

/** {@link ChatPanel} 属性。 */
export interface ChatPanelProps {
  /** 当前项目标识，向下透传给输入条以驱动发送。 */
  projectId: string;
  /** 当前用户可用模型目录。 */
  models: ModelCatalogEntry[];
  /** 收起面板。 */
  onCollapse: () => void;
}

/**
 * 对话面板组件。
 *
 * @param props - 组件属性
 * @param props.projectId - 当前项目标识
 * @returns 右侧对话面板
 */
export function ChatPanel({ projectId, models, onCollapse }: ChatPanelProps) {
  const { t } = useTranslation();
  const { success, error: toastError } = useToast();
  // 仅订阅是否为空，避免随每条增量重渲染容器。空态以「无任何可渲染消息」为准——
  // 退化消息（如空白项目的空内容首条消息）不计入，故空白项目仍展示引导大标题
  const isEmpty = useChatStore((s) => !s.messages.some(isRenderableMessage));
  const conversations = useChatStore((s) => s.conversations);
  const conversationId = useChatStore((s) => s.conversationId);
  const isSending = useChatStore((s) => s.isSending);
  const [switchingConversation, setSwitchingConversation] = useState(false);
  const currentConversation = conversations.find((item) => item.id === conversationId) ?? null;

  /** 切换会话前加载其最近消息与生成任务，确保订阅切换时界面已有完整快照。 */
  const handleSelectConversation = async (conversation: ConversationRow) => {
    if (conversation.id === conversationId || isSending || switchingConversation) return;
    setSwitchingConversation(true);
    try {
      const supabase = getBrowserSupabase();
      const [messagesResult, generationsResult] = await Promise.all([
        supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', conversation.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(MESSAGES_PAGE_SIZE),
        supabase
          .from('generations')
          .select('*')
          .eq('conversation_id', conversation.id)
          .order('created_at', { ascending: true }),
      ]);
      const queryError = messagesResult.error ?? generationsResult.error;
      if (queryError) throw queryError;
      const descending = messagesResult.data ?? [];
      useChatStore.getState().setCurrentConversation({
        conversation,
        messages: descending.slice().reverse(),
        generations: generationsResult.data ?? [],
        hasMoreMessages: descending.length >= MESSAGES_PAGE_SIZE,
      });
    } catch (error) {
      toastError(error instanceof Error ? error.message : t('error.internal_error'));
    } finally {
      setSwitchingConversation(false);
    }
  };

  // 新对话：在当前项目下建一条新会话并切换（清空消息流，保留所选模型 / 模式）
  const handleNewConversation = async () => {
    const { data, error } = await getBrowserSupabase()
      .from('conversations')
      .insert({ project_id: projectId })
      .select('*')
      .single();
    if (error || !data) {
      toastError(error?.message ?? t('error.internal_error'));
      return;
    }
    useChatStore.getState().startConversation(data);
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={switchingConversation || isSending}
              className="inline-flex min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60"
            >
              <span className="max-w-52 truncate">
                {currentConversation?.title || t('chat.newConversation')}
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 min-w-64 overflow-y-auto">
            {conversations.map((conversation) => (
              <DropdownMenuItem
                key={conversation.id}
                onSelect={() => void handleSelectConversation(conversation)}
                className="justify-between gap-3"
              >
                <span className="min-w-0 truncate">
                  {conversation.title || t('chat.newConversation')}
                </span>
                {conversation.id === conversationId ? (
                  <Check className="size-4 shrink-0 text-accent" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label={t('chat.newConversation')}
            disabled={isSending || switchingConversation}
            onClick={() => void handleNewConversation()}
          >
            <MessageSquarePlus />
          </IconButton>
          <IconButton size="sm" label={t('common.share')} onClick={() => void handleShare()}>
            <Share2 />
          </IconButton>
          <IconButton size="sm" label={t('design.collapsePanel')} onClick={onCollapse}>
            <PanelRightClose />
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
        <ChatInput projectId={projectId} models={models} />
      </div>
    </div>
  );
}
