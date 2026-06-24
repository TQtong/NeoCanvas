'use client';

/**
 * 单条对话气泡（第 04 篇第三节）。
 *
 * 用户消息靠右、紫色强调；助手消息靠左、浅灰底。承载附件缩略行、@提及标签、流式进行态
 * 与生成进行态提示。内容以 `whitespace-pre-wrap` 原样保留换行与空白。
 *
 * @module components/chat/MessageBubble
 */

import {
  Frame,
  ImageIcon,
  PenLine,
  Shapes,
  Sparkles,
  Type,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { MessageAttachment, MessageMention, MessageView, NodeType } from '@/types';
import { TERMINAL_GENERATION_STATUSES } from '@/types';
import { useChatStore } from '@/stores/chat-store';
import { useTranslation } from '@/i18n';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils/cn';

/** 节点类型 → 提及标签前的类型图标。 */
const MENTION_TYPE_ICON: Record<NodeType, LucideIcon> = {
  image: ImageIcon,
  text: Type,
  shape: Shapes,
  drawing: PenLine,
  video: Video,
  generation_placeholder: Sparkles,
  frame: Frame,
};

/** 单个附件缩略图。无可用缩略图时回退为种类图标占位。 */
function AttachmentThumb({ attachment }: { attachment: MessageAttachment }) {
  const FallbackIcon = attachment.kind === 'video' ? Video : ImageIcon;
  return (
    <div className="size-12 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-background/40">
      {attachment.thumbnailUrl ? (
        // 已注入签名 URL 时直接展示缩略图
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.thumbnailUrl}
          alt={attachment.name}
          className="size-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <FallbackIcon className="size-5" />
        </div>
      )}
    </div>
  );
}

/** 单个 @提及标签。 */
function MentionChip({ mention, onAccent }: { mention: MessageMention; onAccent: boolean }) {
  const Icon = MENTION_TYPE_ICON[mention.nodeType];
  return (
    <span
      className={cn(
        'inline-flex max-w-[12rem] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
        // 在紫色气泡上用半透明白底，在浅灰气泡上用强调色
        onAccent
          ? 'bg-accent-foreground/15 text-accent-foreground'
          : 'bg-accent-muted text-accent',
      )}
    >
      <Icon className="size-3 shrink-0 opacity-80" />
      <span className="truncate">@{mention.label}</span>
    </span>
  );
}

/**
 * 对话气泡组件。
 *
 * @param props - 组件属性
 * @param props.message - 待渲染的消息视图
 * @returns 单条消息的气泡元素
 */
export function MessageBubble({ message }: { message: MessageView }) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  // 用户气泡为紫色强调底，其上的次级元素需用 accent-foreground 体系着色
  const onAccent = isUser;
  const hasAttachments = message.attachments.length > 0;
  const hasMentions = message.mentions.length > 0;
  // 「生成中」徽标：本条消息触发的生成里，只要还有任一未达终态（或状态未知）就显示；
  // 全部 succeeded/failed/cancelled 后由实时回流的状态收敛而自动消失（见 chat-store）。
  const generationStatus = useChatStore((s) => s.generationStatus);
  const genIds = message.generationIds ?? [];
  const isGenerating =
    genIds.length > 0 &&
    genIds.some((id) => {
      const status = generationStatus[id];
      return status === undefined || !TERMINAL_GENERATION_STATUSES.has(status);
    });

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-soft',
          isUser
            ? 'ml-auto bg-accent text-accent-foreground'
            : 'mr-auto bg-muted text-foreground',
        )}
      >
        {/* 附件缩略行：置于文本之上 */}
        {hasAttachments ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.attachments.map((attachment) => (
              <AttachmentThumb key={attachment.assetId} attachment={attachment} />
            ))}
          </div>
        ) : null}

        {/* @提及标签行 */}
        {hasMentions ? (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {message.mentions.map((mention) => (
              <MentionChip key={mention.nodeId} mention={mention} onAccent={onAccent} />
            ))}
          </div>
        ) : null}

        {/* 正文：保留换行与空白 */}
        {message.content ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
        ) : null}

        {/* 流式进行态：内容末尾的思考指示 */}
        {message.streaming ? (
          <span
            className={cn(
              'mt-1 inline-flex items-center gap-1.5 text-xs',
              onAccent ? 'text-accent-foreground/80' : 'text-muted-foreground',
            )}
          >
            <Spinner className="size-3.5" label={t('chat.thinking')} />
            {t('chat.thinking')}
          </span>
        ) : null}

        {/* 生成进行态：本条消息触发了生成任务 */}
        {isGenerating ? (
          <span
            className={cn(
              'mt-1 flex items-center gap-1.5 text-xs',
              onAccent ? 'text-accent-foreground/80' : 'text-accent',
            )}
          >
            <Sparkles className="size-3.5 shrink-0" />
            {t('chat.generating')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
