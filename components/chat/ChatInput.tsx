'use client';

/**
 * 对话输入区（第 01 篇、第 04 篇第六节）。
 *
 * 对话面板底部的复合输入控件：浮层卡片承载一个多行自适应文本框，绑定对话状态库的草稿；
 * 上方以可删除「胶囊」呈现待发送的提及与附件；键入 `@` 弹出提及选择器；左下为附件上传入口，
 * 右下为 Agent 模式切换、发送按钮与高级入口占位。Enter 发送、Shift+Enter 换行；发送经
 * {@link useConversation} 驱动智能体编排，错误以轻量提示条告知。监听对话状态库的聚焦请求
 * （C 快捷键、画布「以此再生成」）以聚焦文本框。
 *
 * @module components/chat/ChatInput
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Cuboid,
  Frame,
  ImageIcon,
  MessageSquare,
  PenLine,
  Paperclip,
  Shapes,
  Sparkles,
  Type,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { MessageAttachment, MessageMention, NodeType } from '@/types';
import { useChatStore } from '@/stores/chat-store';
import { useConversation } from '@/lib/hooks/use-conversation';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';
import { AgentModeDropdown } from './AgentModeDropdown';
import { AttachmentUploader } from './AttachmentUploader';
import { MentionPicker } from './MentionPicker';

/** 文本框最大高度（px），超出后内部滚动。 */
const TEXTAREA_MAX_HEIGHT = 160;

/** 节点类型 → 提及胶囊图标，与图层列表 / 提及选择器一致。 */
const MENTION_ICON: Record<NodeType, LucideIcon> = {
  image: ImageIcon,
  text: Type,
  shape: Shapes,
  drawing: PenLine,
  video: Video,
  generation_placeholder: Sparkles,
  media_panel: MessageSquare,
  frame: Frame,
};

/** 对话输入区属性。 */
export interface ChatInputProps {
  /** 当前项目标识，发送时传入编排函数与附件上传。 */
  projectId: string;
}

/** 单个提及胶囊。 */
function MentionChip({
  mention,
  onRemove,
}: {
  mention: MessageMention;
  onRemove: (nodeId: string) => void;
}) {
  const Icon = MENTION_ICON[mention.nodeType];
  return (
    <span className="inline-flex max-w-[12rem] items-center gap-1 rounded-lg bg-accent-muted py-1 pl-2 pr-1 text-xs font-medium text-accent">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">@{mention.label}</span>
      <button
        type="button"
        aria-label="移除提及"
        onClick={() => onRemove(mention.nodeId)}
        className="grid size-4 shrink-0 place-items-center rounded transition-colors hover:bg-accent/20"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** 单个附件胶囊。 */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: MessageAttachment;
  onRemove: (assetId: string) => void;
}) {
  return (
    <span className="inline-flex max-w-[12rem] items-center gap-1 rounded-lg border border-border bg-muted py-1 pl-1 pr-1 text-xs text-foreground">
      {/* 有缩略图则展示缩略图，否则回退为通用附件图标 */}
      {attachment.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- 运行时签名 URL，非静态资源
        <img
          src={attachment.thumbnailUrl}
          alt={attachment.name}
          className="size-5 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="grid size-5 shrink-0 place-items-center rounded bg-background">
          <Paperclip className="size-3 text-muted-foreground" />
        </span>
      )}
      <span className="truncate pl-0.5">{attachment.name}</span>
      <button
        type="button"
        aria-label="移除附件"
        onClick={() => onRemove(attachment.assetId)}
        className="grid size-4 shrink-0 place-items-center rounded transition-colors hover:bg-foreground/10"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/**
 * 对话输入区组件。
 *
 * @param props - 见 {@link ChatInputProps}
 * @returns 对话输入区
 */
export function ChatInput({ projectId }: ChatInputProps) {
  const { t, tError } = useTranslation();
  const toast = useToast();
  const { send } = useConversation();

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 对话状态库切片
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const pendingMentions = useChatStore((s) => s.pendingMentions);
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const removeMention = useChatStore((s) => s.removeMention);
  const removeAttachment = useChatStore((s) => s.removeAttachment);
  const addMention = useChatStore((s) => s.addMention);
  const isSending = useChatStore((s) => s.isSending);
  const focusNonce = useChatStore((s) => s.focusNonce);

  // 提及选择器开合
  const [mentionOpen, setMentionOpen] = useState(false);
  // 触发提及的 `@` 在草稿中的下标，选中后据此剥除触发字符
  const triggerIndexRef = useRef<number | null>(null);

  // 多行自适应：内容变化时按 scrollHeight 调整高度（封顶后内部滚动）
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, [draft]);

  // 响应聚焦请求（C 快捷键、画布「以此再生成」）：nonce 变化即聚焦并把光标移到末尾
  useEffect(() => {
    if (focusNonce === 0) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [focusNonce]);

  // 是否可发送：有非空文本或至少一个附件，且未在发送中
  const canSend = (draft.trim().length > 0 || pendingAttachments.length > 0) && !isSending;

  /** 执行发送：成功后由 send 内部清空草稿，失败以提示条告知。 */
  const handleSend = useCallback(async () => {
    if (!canSend) return;
    setMentionOpen(false);
    try {
      await send(projectId);
    } catch (err) {
      // useConversation 抛出的均为规范化后的 ApiClientError
      toast.error(tError(err as Parameters<typeof tError>[0]));
    }
  }, [canSend, send, projectId, toast, tError]);

  /** 处理草稿变化：写回状态库，并据光标前是否新出现 `@` 决定弹出提及选择器。 */
  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const caret = event.target.selectionStart ?? value.length;
    setDraft(value);

    // 光标紧邻处刚键入 `@`（行首或前一字符为空白）时触发提及
    const prevChar = caret >= 2 ? value[caret - 2] ?? '' : '';
    if (value[caret - 1] === '@' && (caret === 1 || /\s/.test(prevChar))) {
      triggerIndexRef.current = caret - 1;
      setMentionOpen(true);
    } else if (mentionOpen) {
      // 触发字符被删除或光标移离则收起
      const idx = triggerIndexRef.current;
      if (idx == null || value[idx] !== '@') setMentionOpen(false);
    }
  };

  /** 选中提及：并入待发送提及，并从草稿剥除触发的 `@` 字符。 */
  const handleSelectMention = (mention: MessageMention) => {
    addMention(mention);
    const idx = triggerIndexRef.current;
    if (idx != null) {
      // 剥除触发字符（连同其后紧跟的查询片段尚未实现，仅去掉单个 `@`）
      const current = useChatStore.getState().draft;
      if (current[idx] === '@') {
        const next = current.slice(0, idx) + current.slice(idx + 1);
        setDraft(next);
      }
    }
    triggerIndexRef.current = null;
    setMentionOpen(false);
    // 选完回到文本框继续输入
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** 键盘处理：Enter 发送、Shift+Enter 换行、Esc 收起提及选择器。 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && mentionOpen) {
      event.preventDefault();
      setMentionOpen(false);
      return;
    }
    // 提及选择器打开时把 Enter 让给选择器（此处不发送）
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (mentionOpen) return;
      void handleSend();
    }
  };

  const hasChips = pendingMentions.length > 0 || pendingAttachments.length > 0;

  return (
    <div className="glass relative flex flex-col gap-2 rounded-2xl p-2.5 shadow-soft">
      {/* 待发送提及 / 附件胶囊区 */}
      {hasChips ? (
        <div className="flex flex-wrap gap-1.5 px-1 pt-0.5">
          {pendingMentions.map((mention) => (
            <MentionChip key={mention.nodeId} mention={mention} onRemove={removeMention} />
          ))}
          {pendingAttachments.map((attachment) => (
            <AttachmentChip
              key={attachment.assetId}
              attachment={attachment}
              onRemove={removeAttachment}
            />
          ))}
        </div>
      ) : null}

      {/* 多行自适应文本框 */}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder={t('chat.inputPlaceholder')}
        className={cn(
          'w-full resize-none bg-transparent px-1.5 text-sm leading-relaxed text-foreground outline-none',
          'placeholder:text-muted-foreground',
        )}
        style={{ maxHeight: TEXTAREA_MAX_HEIGHT }}
      />

      {/* 提及选择器：以输入区为锚点向上弹出 */}
      <MentionPicker
        open={mentionOpen}
        onClose={() => setMentionOpen(false)}
        onSelect={handleSelectMention}
      />

      {/* 控制行：左下附件，右下 Agent 模式 + 高级入口 + 发送 */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-1">
          <AttachmentUploader projectId={projectId} />
        </div>

        <div className="flex items-center gap-1">
          <AgentModeDropdown />
          {/* 高级入口占位（3D / 进阶能力，后续接入） */}
          <Tooltip content={t('common.settings')}>
            <IconButton size="sm" label={t('common.settings')} disabled>
              <Cuboid />
            </IconButton>
          </Tooltip>
          {/* 发送按钮：草稿空且无附件时禁用 */}
          <IconButton
            size="md"
            label={t('chat.send')}
            disabled={!canSend}
            onClick={() => void handleSend()}
            className={cn(
              'rounded-xl',
              canSend
                ? 'bg-accent text-accent-foreground hover:bg-accent/90 hover:text-accent-foreground'
                : 'bg-muted',
            )}
          >
            <ArrowUp />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
