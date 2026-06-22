'use client';

/**
 * 对话领域钩子：发送消息并驱动智能体编排（第 04 篇第六节、第 06 篇 agent-orchestrate）。
 *
 * 发送流程：乐观追加用户消息并写入 messages（用户消息可由客户端写入）→ 调用
 * agent-orchestrate 流式函数 → 按事件把助手进行态逐步更新为完成态；图 / 视频产出走
 * 异步生成流水线，稍后经实时面落画布。
 *
 * @module lib/hooks/use-conversation
 */

import { useCallback } from 'react';
import type { AgentOrchestrateEvent, AgentOrchestrateRequest } from '@/types';
import { EDGE_FUNCTIONS } from '@/types';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { invokeEdgeStream } from '@/lib/edge/client';
import { normalizeUnknownError } from '@/lib/edge/errors';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { uuid } from '@/lib/utils/id';
import { translate } from '@/i18n';

/** useConversation 返回值。 */
export interface UseConversation {
  /** 发送当前草稿（含提及与附件）。 */
  send: (projectId: string) => Promise<void>;
}

/**
 * 当前时间的 ISO 串。集中一处便于测试替换。
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 对话钩子。
 *
 * @returns 发送动作
 */
export function useConversation(): UseConversation {
  const send = useCallback(async (projectId: string) => {
    const chat = useChatStore.getState();
    const {
      conversationId,
      draft,
      pendingMentions,
      pendingAttachments,
      selectedModelKey,
      agentMode,
    } = chat;

    const content = draft.trim();
    if (!conversationId || (!content && pendingAttachments.length === 0)) return;

    const locale = useSessionStore.getState().locale;
    const messageId = uuid();
    const createdAt = nowIso();

    // 乐观追加用户消息并清空草稿
    chat.addUserMessage({
      id: messageId,
      role: 'user',
      content,
      modelKey: selectedModelKey,
      agentMode,
      mentions: pendingMentions,
      attachments: pendingAttachments,
      createdAt,
      pending: true,
    });
    const mentions = pendingMentions;
    const attachments = pendingAttachments;
    chat.clearDraft();
    chat.setSending(true);

    const supabase = getBrowserSupabase();
    // 写入 messages（用户消息可由客户端直写）
    const { error: insertError } = await supabase.from('messages').insert({
      id: messageId,
      conversation_id: conversationId,
      role: 'user',
      content: content || null,
      model_key: selectedModelKey,
      agent_mode: agentMode,
      mentions,
      attachments,
    });
    if (insertError) {
      chat.updateMessage(messageId, { pending: false });
      chat.setSending(false);
      throw normalizeUnknownError(insertError);
    }
    chat.updateMessage(messageId, { pending: false });

    const request: AgentOrchestrateRequest = {
      projectId,
      conversationId,
      messageId,
      content,
      agentMode,
      modelKey: selectedModelKey ?? '',
      mentions,
      attachments,
    };

    let assistantId: string | null = null;
    try {
      for await (const event of invokeEdgeStream<AgentOrchestrateEvent>(
        EDGE_FUNCTIONS.agentOrchestrate,
        request,
      )) {
        switch (event.type) {
          case 'message_created':
            assistantId = event.assistantMessageId;
            chat.addAssistantMessage({
              id: event.assistantMessageId,
              role: 'assistant',
              content: '',
              modelKey: selectedModelKey,
              agentMode,
              mentions: [],
              attachments: [],
              createdAt: nowIso(),
              streaming: true,
              generationIds: [],
            });
            break;
          case 'text_delta':
            if (assistantId) chat.appendAssistantDelta(assistantId, event.delta);
            break;
          case 'generation_started':
            if (assistantId) chat.attachGeneration(assistantId, event.generationId);
            break;
          case 'done':
            chat.finalizeAssistant(event.assistantMessageId, {
              generationIds: event.generationIds,
            });
            break;
          case 'error':
            if (assistantId) {
              chat.finalizeAssistant(assistantId, {
                content:
                  (assistantId ? '' : '') +
                  translate(locale, `error.${event.code}`) +
                  (event.message ? `\n${event.message}` : ''),
              });
            }
            break;
          default:
            break;
        }
      }
    } catch (err) {
      const apiErr = normalizeUnknownError(err);
      if (assistantId) {
        chat.finalizeAssistant(assistantId, { content: translate(locale, `error.${apiErr.code}`) });
      }
      throw apiErr;
    } finally {
      chat.setSending(false);
    }
  }, []);

  return { send };
}
