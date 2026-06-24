'use client';

/**
 * 消息流列表（第 04 篇第三节）。
 *
 * 订阅对话状态库的消息切片，逐条渲染 {@link MessageBubble}。新消息或流式增量到达时
 * 自动滚到底；但一旦用户主动上滚离开底部，则暂停自动滚动，避免打断回溯阅读，待其重新
 * 滚回底部后恢复。
 *
 * @module components/chat/MessageList
 */

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { getBrowserSupabase } from '@/lib/supabase/client';
import { MESSAGES_PAGE_SIZE, messageRowToView } from '@/lib/data/mappers';
import { MessageBubble } from './MessageBubble';

/** 判定为「贴近底部」的像素阈值，容忍亚像素与惯性滚动误差。 */
const NEAR_BOTTOM_THRESHOLD = 64;
/** 贴近顶部触发「加载更早」的像素阈值。 */
const NEAR_TOP_THRESHOLD = 24;

/**
 * 消息列表组件。
 *
 * @returns 可滚动的消息流容器
 */
export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  // 滚动容器
  const scrollRef = useRef<HTMLDivElement>(null);
  // 是否处于「跟随底部」状态：用户上滚时置 false，回到底部时恢复 true
  const stickToBottomRef = useRef(true);

  // 加载更早一页历史（keyset：早于当前最早消息），并在前置后保持视口位置不跳动
  const loadOlder = useCallback(async () => {
    const state = useChatStore.getState();
    if (!state.conversationId || !state.hasMoreMessages || state.loadingOlder) return;
    const earliest = state.messages[0];
    if (!earliest) return;

    state.setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;

    const { data } = await getBrowserSupabase()
      .from('messages')
      .select('*')
      .eq('conversation_id', state.conversationId)
      .or(
        `created_at.lt.${earliest.createdAt},and(created_at.eq.${earliest.createdAt},id.lt.${earliest.id})`,
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(MESSAGES_PAGE_SIZE);

    const older = (data ?? []).map(messageRowToView).reverse();
    useChatStore.getState().prependOlderMessages(older, older.length >= MESSAGES_PAGE_SIZE);

    // 前置插入会增高内容，补偿 scrollTop 以维持当前阅读位置
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2) el2.scrollTop = el2.scrollHeight - prevHeight;
    });
  }, []);

  // 监听滚动：更新跟随状态；贴近顶部时加载更早历史
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceToBottom <= NEAR_BOTTOM_THRESHOLD;
      if (el.scrollTop <= NEAR_TOP_THRESHOLD) void loadOlder();
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loadOlder]);

  // 消息变化时，仅在跟随底部状态下滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4">
      <div className="flex flex-col gap-3">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}
