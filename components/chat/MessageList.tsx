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

import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chat-store';
import { MessageBubble } from './MessageBubble';

/** 判定为「贴近底部」的像素阈值，容忍亚像素与惯性滚动误差。 */
const NEAR_BOTTOM_THRESHOLD = 64;

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

  // 监听滚动：根据与底部的距离更新跟随状态
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceToBottom <= NEAR_BOTTOM_THRESHOLD;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

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
