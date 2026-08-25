'use client';

/**
 * 对话状态库（第 04 篇第三、六节）。
 *
 * 持有当前项目的会话摘要、当前消息流、每条会话独立的输入草稿、流式缓冲、模型与 Agent
 * 模式。服务端快照、乐观消息、流式事件与 Realtime 回流都按实体标识合并，避免重复追加或
 * 在重连时覆盖尚未确认的本地消息。
 *
 * @module stores/chat-store
 */

import { create } from 'zustand';
import type {
  AgentMode,
  ConversationRow,
  GenerationRow,
  GenerationStatus,
  MessageAttachment,
  MessageMention,
  MessageRow,
  MessageView,
  RealtimeChange,
} from '@/types';
import { messageRowToView } from '@/lib/data/mappers';

/** 一条会话未发送的输入状态。 */
interface ConversationDraftState {
  draft: string;
  mentions: MessageMention[];
  attachments: MessageAttachment[];
}

/** ChatStore 水合参数。 */
export interface HydrateProjectChatParams {
  projectId: string;
  conversations: ConversationRow[];
  conversationId: string | null;
  messages: MessageRow[];
  generations: GenerationRow[];
  selectedModelKey: string | null;
  agentMode?: AgentMode;
  hasMoreMessages?: boolean;
}

/** 会话切换或快照校正参数。 */
export interface ConversationSnapshot {
  conversation: ConversationRow;
  messages: MessageRow[];
  generations: GenerationRow[];
  hasMoreMessages: boolean;
}

/** 对话状态库的状态与动作。 */
export interface ChatState {
  /** 当前项目标识。 */
  projectId: string | null;
  /** 项目内会话摘要，按最近更新时间排序。 */
  conversations: ConversationRow[];
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
  /** 各生成任务的最新状态。 */
  generationStatus: Record<string, GenerationStatus>;
  /** 聚焦请求计数器。 */
  focusNonce: number;
  /** 各会话独立草稿；始终与当前草稿同步。 */
  _draftsByConversation: Record<string, ConversationDraftState>;

  /** 以项目服务端快照成套水合；同项目重复水合不会覆盖未确认消息和草稿。 */
  hydrateProjectChat: (params: HydrateProjectChatParams) => void;
  /** 切换并水合指定会话。 */
  setCurrentConversation: (snapshot: ConversationSnapshot) => void;
  /** 新建会话后切换到该空会话。 */
  startConversation: (conversation: ConversationRow) => void;
  /** 插入或更新一条会话摘要。 */
  upsertConversation: (conversation: ConversationRow) => void;
  /** 以重连快照校正当前会话，同时保留本地未确认/流式消息。 */
  reconcileSnapshot: (params: {
    conversations: ConversationRow[];
    messages: MessageRow[];
    generations: GenerationRow[];
    hasMoreMessages: boolean;
  }) => void;
  /** 把更早的一页历史消息前置插入。 */
  prependOlderMessages: (older: MessageView[], hasMore: boolean) => void;
  /** 设置“正在加载更早消息”标记。 */
  setLoadingOlder: (value: boolean) => void;
  /** 离开项目时重置。 */
  reset: () => void;

  setDraft: (draft: string) => void;
  clearDraft: () => void;
  addMention: (mention: MessageMention) => void;
  removeMention: (nodeId: string) => void;
  addAttachment: (attachment: MessageAttachment) => void;
  removeAttachment: (assetId: string) => void;
  setModel: (modelKey: string | null) => void;
  setAgentMode: (mode: AgentMode) => void;
  setSending: (value: boolean) => void;
  requestFocus: () => void;

  addUserMessage: (message: MessageView) => void;
  addAssistantMessage: (message: MessageView) => void;
  appendAssistantDelta: (messageId: string, delta: string) => void;
  finalizeAssistant: (messageId: string, patch?: Partial<MessageView>) => void;
  attachGeneration: (messageId: string, generationId: string) => void;
  updateMessage: (id: string, patch: Partial<MessageView>) => void;
  applyRemoteMessage: (change: RealtimeChange<MessageRow>) => void;
  applyRemoteGeneration: (change: RealtimeChange<GenerationRow>) => void;
}

const EMPTY_DRAFT: ConversationDraftState = { draft: '', mentions: [], attachments: [] };

/** 按创建时间与标识稳定排序，避免同毫秒消息在重连后抖动。 */
function sortMessages(messages: MessageView[]): MessageView[] {
  return [...messages].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
  );
}

/** 根据 generation.message_id 恢复助手消息的生成任务集合。 */
function attachGenerationLinks(
  messages: MessageView[],
  generations: GenerationRow[],
): MessageView[] {
  const assistantByUserMessageId = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.userMessageId) {
      assistantByUserMessageId.set(message.userMessageId, message.id);
    }
  }

  const idsByMessage = new Map<string, string[]>();
  for (const generation of generations) {
    if (!generation.message_id) continue;
    const messageId = assistantByUserMessageId.get(generation.message_id) ?? generation.message_id;
    const ids = idsByMessage.get(messageId) ?? [];
    if (!ids.includes(generation.id)) ids.push(generation.id);
    idsByMessage.set(messageId, ids);
  }

  return messages.map((message) => {
    const generationIds = idsByMessage.get(message.id);
    return generationIds ? { ...message, generationIds } : message;
  });
}

/** 把数据库消息和生成任务映射为可直接展示的快照。 */
function buildMessageSnapshot(rows: MessageRow[], generations: GenerationRow[]): MessageView[] {
  return attachGenerationLinks(rows.map(messageRowToView), generations);
}

/** 构造 generation id → 状态索引。 */
function buildGenerationStatus(generations: GenerationRow[]): Record<string, GenerationStatus> {
  return Object.fromEntries(generations.map((generation) => [generation.id, generation.status]));
}

/**
 * 服务端消息与本地运行时状态合并。服务端字段为权威值，但未确认、流式文本与已知生成关联不能
 * 因重连快照到达顺序而丢失。
 */
function mergeMessages(serverMessages: MessageView[], localMessages: MessageView[]): MessageView[] {
  const localById = new Map(localMessages.map((message) => [message.id, message]));
  const serverIds = new Set(serverMessages.map((message) => message.id));
  const merged = serverMessages.map((server) => {
    const local = localById.get(server.id);
    if (!local) return server;
    const keepLocalStream =
      Boolean(local.streaming) && local.content.length > server.content.length;
    return {
      ...server,
      content: keepLocalStream ? local.content : server.content,
      streaming: local.streaming,
      pending: false,
      generationIds: Array.from(
        new Set([...(server.generationIds ?? []), ...(local.generationIds ?? [])]),
      ),
    };
  });

  for (const local of localMessages) {
    if (!serverIds.has(local.id) && (local.pending || local.streaming)) merged.push(local);
  }
  return sortMessages(merged);
}

/** 返回当前会话草稿的不可变更新。 */
function updateCurrentDraft(
  state: ChatState,
  patch: Partial<ConversationDraftState>,
): Pick<ChatState, 'draft' | 'pendingMentions' | 'pendingAttachments' | '_draftsByConversation'> {
  const next: ConversationDraftState = {
    draft: patch.draft ?? state.draft,
    mentions: patch.mentions ?? state.pendingMentions,
    attachments: patch.attachments ?? state.pendingAttachments,
  };
  return {
    draft: next.draft,
    pendingMentions: next.mentions,
    pendingAttachments: next.attachments,
    _draftsByConversation: state.conversationId
      ? { ...state._draftsByConversation, [state.conversationId]: next }
      : state._draftsByConversation,
  };
}

/** 初始状态，reset 与创建复用，防止漏清跨项目数据。 */
function initialState(): Pick<
  ChatState,
  | 'projectId'
  | 'conversations'
  | 'conversationId'
  | 'messages'
  | 'draft'
  | 'pendingMentions'
  | 'pendingAttachments'
  | 'selectedModelKey'
  | 'agentMode'
  | 'isSending'
  | 'hasMoreMessages'
  | 'loadingOlder'
  | 'generationStatus'
  | 'focusNonce'
  | '_draftsByConversation'
> {
  return {
    projectId: null,
    conversations: [],
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
    _draftsByConversation: {},
  };
}

export const useChatStore = create<ChatState>((set) => ({
  ...initialState(),

  hydrateProjectChat: (params) =>
    set((state) => {
      const serverMessages = buildMessageSnapshot(params.messages, params.generations);
      if (state.projectId === params.projectId) {
        return {
          conversations: params.conversations,
          conversationId: params.conversationId,
          messages: mergeMessages(serverMessages, state.messages),
          selectedModelKey: state.selectedModelKey ?? params.selectedModelKey,
          generationStatus: {
            ...state.generationStatus,
            ...buildGenerationStatus(params.generations),
          },
          hasMoreMessages: params.hasMoreMessages ?? false,
          loadingOlder: false,
        };
      }

      return {
        ...initialState(),
        projectId: params.projectId,
        conversations: params.conversations,
        conversationId: params.conversationId,
        messages: serverMessages,
        selectedModelKey: params.selectedModelKey,
        agentMode: params.agentMode ?? 'generate',
        hasMoreMessages: params.hasMoreMessages ?? false,
        generationStatus: buildGenerationStatus(params.generations),
      };
    }),

  setCurrentConversation: ({ conversation, messages, generations, hasMoreMessages }) =>
    set((state) => {
      const draft = state._draftsByConversation[conversation.id] ?? EMPTY_DRAFT;
      return {
        conversations: [
          conversation,
          ...state.conversations.filter((item) => item.id !== conversation.id),
        ],
        conversationId: conversation.id,
        messages: buildMessageSnapshot(messages, generations),
        draft: draft.draft,
        pendingMentions: draft.mentions,
        pendingAttachments: draft.attachments,
        isSending: false,
        hasMoreMessages,
        loadingOlder: false,
        generationStatus: {
          ...state.generationStatus,
          ...buildGenerationStatus(generations),
        },
      };
    }),

  startConversation: (conversation) =>
    set((state) => ({
      conversations: [
        conversation,
        ...state.conversations.filter((item) => item.id !== conversation.id),
      ],
      conversationId: conversation.id,
      messages: [],
      draft: '',
      pendingMentions: [],
      pendingAttachments: [],
      isSending: false,
      hasMoreMessages: false,
      loadingOlder: false,
      _draftsByConversation: {
        ...state._draftsByConversation,
        [conversation.id]: EMPTY_DRAFT,
      },
    })),

  upsertConversation: (conversation) =>
    set((state) => ({
      conversations: [
        conversation,
        ...state.conversations.filter((item) => item.id !== conversation.id),
      ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    })),

  reconcileSnapshot: ({ conversations, messages, generations, hasMoreMessages }) =>
    set((state) => ({
      conversations,
      messages: mergeMessages(buildMessageSnapshot(messages, generations), state.messages),
      generationStatus: {
        ...state.generationStatus,
        ...buildGenerationStatus(generations),
      },
      hasMoreMessages,
      loadingOlder: false,
    })),

  prependOlderMessages: (older, hasMore) =>
    set((state) => ({
      messages: mergeMessages(older, state.messages),
      hasMoreMessages: hasMore,
      loadingOlder: false,
    })),

  setLoadingOlder: (value) => set({ loadingOlder: value }),
  reset: () => set(initialState()),

  setDraft: (draft) => set((state) => updateCurrentDraft(state, { draft })),
  clearDraft: () =>
    set((state) => updateCurrentDraft(state, { draft: '', mentions: [], attachments: [] })),

  addMention: (mention) =>
    set((state) => {
      if (state.pendingMentions.some((item) => item.nodeId === mention.nodeId)) return state;
      return updateCurrentDraft(state, { mentions: [...state.pendingMentions, mention] });
    }),
  removeMention: (nodeId) =>
    set((state) =>
      updateCurrentDraft(state, {
        mentions: state.pendingMentions.filter((mention) => mention.nodeId !== nodeId),
      }),
    ),

  addAttachment: (attachment) =>
    set((state) => {
      if (state.pendingAttachments.some((item) => item.assetId === attachment.assetId))
        return state;
      return updateCurrentDraft(state, {
        attachments: [...state.pendingAttachments, attachment],
      });
    }),
  removeAttachment: (assetId) =>
    set((state) =>
      updateCurrentDraft(state, {
        attachments: state.pendingAttachments.filter(
          (attachment) => attachment.assetId !== assetId,
        ),
      }),
    ),

  setModel: (modelKey) => set({ selectedModelKey: modelKey }),
  setAgentMode: (mode) => set({ agentMode: mode }),
  setSending: (value) => set({ isSending: value }),
  requestFocus: () => set((state) => ({ focusNonce: state.focusNonce + 1 })),

  addUserMessage: (message) =>
    set((state) => ({
      messages: state.messages.some((item) => item.id === message.id)
        ? state.messages
        : sortMessages([...state.messages, message]),
    })),
  addAssistantMessage: (message) =>
    set((state) => ({
      messages: state.messages.some((item) => item.id === message.id)
        ? state.messages.map((item) =>
            item.id === message.id ? { ...item, ...message, streaming: true } : item,
          )
        : sortMessages([...state.messages, { ...message, streaming: true }]),
    })),

  appendAssistantDelta: (messageId, delta) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? { ...message, content: message.content + delta, streaming: true }
          : message,
      ),
    })),

  finalizeAssistant: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId ? { ...message, ...patch, streaming: false } : message,
      ),
    })),

  attachGeneration: (messageId, generationId) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              generationIds: Array.from(new Set([...(message.generationIds ?? []), generationId])),
            }
          : message,
      ),
    })),

  updateMessage: (id, patch) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...patch } : message,
      ),
    })),

  applyRemoteMessage: (change) => {
    const row =
      change.eventType === 'DELETE'
        ? (change.old as Partial<MessageRow>)
        : (change.new as MessageRow);
    if (!row?.id) return;

    set((state) => {
      if (row.conversation_id && row.conversation_id !== state.conversationId) return state;
      if (change.eventType === 'DELETE') {
        return { messages: state.messages.filter((message) => message.id !== row.id) };
      }

      const view = messageRowToView(row as MessageRow);
      const existing = state.messages.find((message) => message.id === view.id);
      if (!existing) return { messages: sortMessages([...state.messages, view]) };
      const keepLocalStream =
        Boolean(existing.streaming) && existing.content.length > view.content.length;
      return {
        messages: state.messages.map((message) =>
          message.id === view.id
            ? {
                ...message,
                ...view,
                content: keepLocalStream ? existing.content : view.content,
                streaming: existing.streaming,
                pending: false,
                generationIds: existing.generationIds,
              }
            : message,
        ),
      };
    });
  },

  applyRemoteGeneration: (change) => {
    if (change.eventType !== 'INSERT' && change.eventType !== 'UPDATE') return;
    const row = change.new as GenerationRow;
    if (!row?.id) return;
    set((state) => ({
      generationStatus:
        state.generationStatus[row.id] === row.status
          ? state.generationStatus
          : { ...state.generationStatus, [row.id]: row.status },
      messages: state.messages.map((message) => {
        const belongsToAssistant =
          row.message_id &&
          (message.userMessageId === row.message_id || message.id === row.message_id);
        if (!belongsToAssistant) return message;
        return {
          ...message,
          generationIds: Array.from(new Set([...(message.generationIds ?? []), row.id])),
        };
      }),
    }));
  },
}));
