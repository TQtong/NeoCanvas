import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chat-store';
import { conversationRow, generationRow, messageRow } from '../fixtures';

describe('ChatStore 水合与 Realtime 合并', () => {
  beforeEach(() => useChatStore.getState().reset());

  it('水合时把 generation.message_id 恢复到对应助手消息且不重复', () => {
    const user = messageRow('user-1', 'user');
    const assistant = messageRow('assistant-1', 'assistant', { user_message_id: user.id });
    const generation = generationRow('generation-1', { message_id: user.id });
    useChatStore.getState().hydrateProjectChat({
      projectId: 'project-1',
      conversations: [conversationRow('conversation-1')],
      conversationId: 'conversation-1',
      messages: [assistant, user],
      generations: [generation, generation],
      selectedModelKey: 'test-image',
    });

    const messages = useChatStore.getState().messages;
    expect(messages.map((message) => message.id)).toEqual(['assistant-1', 'user-1'].sort());
    expect(messages.find((message) => message.id === 'assistant-1')?.generationIds).toEqual([
      'generation-1',
    ]);
  });

  it('同项目重连快照保留本地 pending 用户消息与更长的流式文本', () => {
    useChatStore.getState().hydrateProjectChat({
      projectId: 'project-1',
      conversations: [conversationRow('conversation-1')],
      conversationId: 'conversation-1',
      messages: [],
      generations: [],
      selectedModelKey: 'test-image',
    });
    useChatStore.getState().addUserMessage({
      id: 'pending-user',
      role: 'user',
      content: '尚未确认',
      modelKey: 'test-image',
      agentMode: 'generate',
      mentions: [],
      attachments: [],
      createdAt: '2026-08-25T08:00:01Z',
      pending: true,
    });
    useChatStore.getState().addAssistantMessage({
      id: 'assistant-stream',
      role: 'assistant',
      content: '完整流式内容',
      modelKey: 'test-image',
      agentMode: 'generate',
      mentions: [],
      attachments: [],
      createdAt: '2026-08-25T08:00:02Z',
      streaming: true,
    });

    useChatStore.getState().reconcileSnapshot({
      conversations: [conversationRow('conversation-1')],
      messages: [messageRow('assistant-stream', 'assistant', { content: '短' })],
      generations: [],
      hasMoreMessages: false,
    });
    const state = useChatStore.getState();
    expect(state.messages.find((message) => message.id === 'pending-user')?.pending).toBe(true);
    expect(state.messages.find((message) => message.id === 'assistant-stream')?.content).toBe(
      '完整流式内容',
    );
  });

  it('每条会话保留独立草稿、提及与附件', () => {
    const first = conversationRow('conversation-1');
    const second = conversationRow('conversation-2');
    useChatStore.getState().hydrateProjectChat({
      projectId: 'project-1',
      conversations: [first, second],
      conversationId: first.id,
      messages: [],
      generations: [],
      selectedModelKey: 'test-image',
    });
    useChatStore.getState().setDraft('第一条草稿');
    useChatStore.getState().addMention({ nodeId: 'node-1', nodeType: 'image', label: '参考图' });
    useChatStore.getState().setCurrentConversation({
      conversation: second,
      messages: [],
      generations: [],
      hasMoreMessages: false,
    });
    useChatStore.getState().setDraft('第二条草稿');
    useChatStore.getState().setCurrentConversation({
      conversation: first,
      messages: [],
      generations: [],
      hasMoreMessages: false,
    });

    expect(useChatStore.getState().draft).toBe('第一条草稿');
    expect(useChatStore.getState().pendingMentions).toHaveLength(1);
  });

  it('Realtime 消息 upsert/delete 与生成状态均幂等', () => {
    useChatStore.getState().hydrateProjectChat({
      projectId: 'project-1',
      conversations: [conversationRow('conversation-1')],
      conversationId: 'conversation-1',
      messages: [
        messageRow('user-1', 'user'),
        messageRow('assistant-1', 'assistant', { user_message_id: 'user-1' }),
      ],
      generations: [],
      selectedModelKey: 'test-image',
    });
    const generation = generationRow('generation-1', {
      message_id: 'user-1',
      status: 'running',
    });
    useChatStore.getState().applyRemoteGeneration({
      eventType: 'UPDATE',
      table: 'generations',
      new: generation,
      old: {},
    });
    useChatStore.getState().applyRemoteGeneration({
      eventType: 'UPDATE',
      table: 'generations',
      new: generation,
      old: {},
    });
    expect(useChatStore.getState().generationStatus['generation-1']).toBe('running');
    expect(
      useChatStore.getState().messages.find((message) => message.id === 'assistant-1')
        ?.generationIds,
    ).toEqual(['generation-1']);

    useChatStore.getState().applyRemoteMessage({
      eventType: 'DELETE',
      table: 'messages',
      new: {},
      old: { id: 'assistant-1', conversation_id: 'conversation-1' },
    });
    expect(useChatStore.getState().messages.some((message) => message.id === 'assistant-1')).toBe(
      false,
    );
  });
});
