'use client';

/**
 * 对话状态库（第 04 篇第三、六节）。
 *
 * 持有当前会话的消息流、流式接收缓冲、输入框草稿（含待发送的提及与附件）、当前所选
 * 模型与 Agent 模式。协调「乐观追加用户消息 → 触发生成 → 流式 / 实时更新助手消息与
 * 生成态」的时序。
 *
 * @module stores/chat-store
 */

import { create } from 'zustand';
import type {
  AgentMode,
  GenerationRow,
  GenerationStatus,
  MessageAttachment,
  MessageMention,
  MessageRow,
  MessageView,
  RealtimeChange,
} from '@/types';

/** 对话状态库的状态与动作。 */
export interface ChatState {
  /** 当前会话标识。 */
  conversationId: string | null;
  /** 消息流（按时间升序）。 */
  messages: MessageView[];
  /** 输入框草稿文本。 */
  draft: string;
  /** 待发送的提及。 */
  pendingMentions: MessageMention[];
  /** 待发送的附件。 */
  pendingAttachments: MessageAttachment[];
  /** 当前所选模型键。 */
  selectedModelKey: string | null;
  /** 当前 Agent 模式。 */
  agentMode: AgentMode;
  /** 是否正在发送 / 等待响应。 */
  isSending: boolean;
  /** 是否还有更早的历史消息可加载。 */
  hasMoreMessages: boolean;
  /** 是否正在加载更早的历史消息。 */
  loadingOlder: boolean;
  /** 各生成任务的最新状态（按生成 id）：用于判断助手消息是否仍在生成中。 */
  generationStatus: Record<string, GenerationStatus>;
  /** 聚焦请求计数器：递增以请求对话输入框聚焦（C 快捷键、画布「以此再生成」）。 */
  focusNonce: number;

  /** 以服务端历史初始化。 */
  hydrate: (params: {
    conversationId: string;
    messages: MessageView[];
    selectedModelKey: string | null;
    agentMode?: AgentMode;
    hasMoreMessages?: boolean;
  }) => void;
  /** 把更早的一页历史消息前置插入（keyset 向前翻页）。 */
  prependOlderMessages: (older: MessageView[], hasMore: boolean) => void;
  /** 设置「正在加载更早消息」标记。 */
  setLoadingOlder: (value: boolean) => void;
  /** 切换到一条新会话：清空消息流与草稿，保留所选模型与 Agent 模式。 */
  startConversation: (conversationId: string) => void;
  /** 离开项目时重置。 */
  reset: () => void;

  // 草稿
  setDraft: (draft: string) => void;
  clearDraft: () => void;
  addMention: (mention: MessageMention) => void;
  removeMention: (nodeId: string) => void;
  addAttachment: (attachment: MessageAttachment) => void;
  removeAttachment: (assetId: string) => void;

  // 模型 / 模式
  setModel: (modelKey: string) => void;
  setAgentMode: (mode: AgentMode) => void;
  setSending: (value: boolean) => void;
  /** 请求对话输入框聚焦。 */
  requestFocus: () => void;

  // 消息时序
  /** 乐观追加一条用户消息。 */
  addUserMessage: (message: MessageView) => void;
  /** 追加一条助手消息（进行态占位）。 */
  addAssistantMessage: (message: MessageView) => void;
  /** 向某助手消息追加流式文本增量。 */
  appendAssistantDelta: (messageId: string, delta: string) => void;
  /** 标记某助手消息完成（结束流式态）。 */
  finalizeAssistant: (messageId: string, patch?: Partial<MessageView>) => void;
  /** 将一个生成任务关联到某消息（用于进行态展示）。 */
  attachGeneration: (messageId: string, generationId: string) => void;
  /** 更新任意消息。 */
  updateMessage: (id: string, patch: Partial<MessageView>) => void;

  // 远端回流
  applyRemoteMessage: (change: RealtimeChange<MessageRow>) => void;
  /** 远端回流：记录生成任务状态，驱动助手消息「生成中」徽标在生成达终态时结束。 */
  applyRemoteGeneration: (change: RealtimeChange<GenerationRow>) => void;
}

/** 把消息行映射为视图。 */
function rowToMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    role: row.role,
    content: row.content ?? '',
    modelKey: row.model_key,
    agentMode: (row.agent_mode as AgentMode | null) ?? null,
    mentions: row.mentions,
    attachments: row.attachments,
    createdAt: row.created_at,
  };
}

export const useChatStore = create<ChatState>((set) => ({
  conversationId: null,
  messages: [],
  draft: '',
  pendingMentions: [],
  pendingAttachments: [],
  selectedModelKey: null,
  agentMode: 'generate',
  isSending: false,
  hasMoreMessages: false,
  loadingOlder: false,
  generationStatus: {},
  focusNonce: 0,

  hydrate: ({ conversationId, messages, selectedModelKey, agentMode, hasMoreMessages }) =>
    set({
      conversationId,
      messages,
      selectedModelKey,
      agentMode: agentMode ?? 'generate',
      draft: '',
      pendingMentions: [],
      pendingAttachments: [],
      isSending: false,
      hasMoreMessages: hasMoreMessages ?? false,
      loadingOlder: false,
      generationStatus: {},
    }),

  prependOlderMessages: (older, hasMore) =>
    set((state) => ({
      messages: [...older, ...state.messages],
      hasMoreMessages: hasMore,
      loadingOlder: false,
    })),

  setLoadingOlder: (value) => set({ loadingOlder: value }),

  startConversation: (conversationId) =>
    set({
      conversationId,
      messages: [],
      draft: '',
      pendingMentions: [],
      pendingAttachments: [],
      isSending: false,
      hasMoreMessages: false,
      loadingOlder: false,
      generationStatus: {},
    }),

  reset: () =>
    set({
      conversationId: null,
      messages: [],
      draft: '',
      pendingMentions: [],
      pendingAttachments: [],
      isSending: false,
      hasMoreMessages: false,
      loadingOlder: false,
      generationStatus: {},
    }),

  setDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: '', pendingMentions: [], pendingAttachments: [] }),

  addMention: (mention) =>
    set((state) =>
      state.pendingMentions.some((m) => m.nodeId === mention.nodeId)
        ? state
        : { pendingMentions: [...state.pendingMentions, mention] },
    ),
  removeMention: (nodeId) =>
    set((state) => ({ pendingMentions: state.pendingMentions.filter((m) => m.nodeId !== nodeId) })),

  addAttachment: (attachment) =>
    set((state) =>
      state.pendingAttachments.some((a) => a.assetId === attachment.assetId)
        ? state
        : { pendingAttachments: [...state.pendingAttachments, attachment] },
    ),
  removeAttachment: (assetId) =>
    set((state) => ({
      pendingAttachments: state.pendingAttachments.filter((a) => a.assetId !== assetId),
    })),

  setModel: (modelKey) => set({ selectedModelKey: modelKey }),
  setAgentMode: (mode) => set({ agentMode: mode }),
  setSending: (value) => set({ isSending: value }),
  requestFocus: () => set((state) => ({ focusNonce: state.focusNonce + 1 })),

  addUserMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  addAssistantMessage: (message) =>
    set((state) => ({ messages: [...state.messages, { ...message, streaming: true }] })),

  appendAssistantDelta: (messageId, delta) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, content: m.content + delta, streaming: true } : m,
      ),
    })),

  finalizeAssistant: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, ...patch, streaming: false } : m,
      ),
    })),

  attachGeneration: (messageId, generationId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? { ...m, generationIds: [...(m.generationIds ?? []), generationId] }
          : m,
      ),
    })),

  updateMessage: (id, patch) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  applyRemoteMessage: (change) => {
    if (change.eventType !== 'INSERT' && change.eventType !== 'UPDATE') return;
    const row = change.new as MessageRow;
    if (!row?.id) return;
    set((state) => {
      const exists = state.messages.some((m) => m.id === row.id);
      const view = rowToMessageView(row);
      if (exists) {
        return {
          messages: state.messages.map((m) =>
            m.id === row.id ? { ...m, ...view, streaming: m.streaming, generationIds: m.generationIds } : m,
          ),
        };
      }
      // 追加并按时间排序（多设备同步）
      const next = [...state.messages, view].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      return { messages: next };
    });
  },

  applyRemoteGeneration: (change) => {
    if (change.eventType !== 'INSERT' && change.eventType !== 'UPDATE') return;
    const row = change.new as GenerationRow;
    if (!row?.id) return;
    // 记录该生成的最新状态；助手气泡据此判断是否仍在生成（见 MessageBubble）。
    set((state) =>
      state.generationStatus[row.id] === row.status
        ? state
        : { generationStatus: { ...state.generationStatus, [row.id]: row.status } },
    );
  },
}));
