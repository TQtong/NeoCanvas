'use client';

/**
 * 提及选择器（第 04 篇第六节）。
 *
 * 在对话输入框键入 `@` 时弹出的浮层，列出当前画布的全部节点；选中后构造一条
 * {@link MessageMention} 交由调用方写入待发送提及。提及的节点标识即 `canvas_nodes.id`，
 * 与节点映射、生成请求的参考素材引用共用同一套标识语义，使「针对画布具体元素再生成」
 * 类型安全。
 *
 * @module components/chat/MentionPicker
 */

import { useMemo } from 'react';
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
import type { MessageMention, NodeType } from '@/types';
import { useCanvasStore } from '@/stores/canvas-store';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useTranslation } from '@/i18n';

/** 节点类型 → 列表项图标，与图层列表保持一致。 */
const TYPE_ICON: Record<NodeType, LucideIcon> = {
  image: ImageIcon,
  text: Type,
  shape: Shapes,
  drawing: PenLine,
  video: Video,
  generation_placeholder: Sparkles,
  frame: Frame,
};

/** 提及选择器属性。 */
export interface MentionPickerProps {
  /** 是否展开浮层。 */
  open: boolean;
  /** 关闭浮层（点击外部、Esc、或选中后）。 */
  onClose: () => void;
  /** 选中某节点构造的提及。 */
  onSelect: (mention: MessageMention) => void;
}

/**
 * 取节点的提及展示标签：文本取内容摘要，画板取名称，图片 / 视频取中文类型名，其余按类型兜底。
 *
 * @param node - 画布节点
 * @returns 展示用标签
 */
function mentionLabel(node: CanvasFlowNode): string {
  const data = node.data;
  switch (data.type) {
    case 'text':
      // 文本节点取内容首段摘要
      return data.text.trim().slice(0, 24) || '文本';
    case 'frame':
      return data.name || '画板';
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'shape':
      return '形状';
    case 'drawing':
      return '手绘';
    case 'generation_placeholder':
      return data.promptSummary.slice(0, 24) || '生成中';
    default:
      return '元素';
  }
}

/**
 * 由节点构造一条待发送提及。仅图片 / 视频节点携带 `assetId`，其余为 null。
 *
 * @param node - 画布节点
 * @returns 提及对象
 */
function toMention(node: CanvasFlowNode): MessageMention {
  const data = node.data;
  return {
    nodeId: node.id,
    nodeType: data.type,
    label: mentionLabel(node),
    // 仅媒体节点绑定资产，便于生成时直接取媒体作参考
    assetId: data.type === 'image' || data.type === 'video' ? data.assetId : null,
  };
}

/**
 * 提及选择器组件。
 *
 * 以无尺寸锚点（{@link PopoverAnchor}）依附在输入框上方，由父组件以 `open` 控制开合；
 * 列表为空时展示占位文案。
 *
 * @param props - 见 {@link MentionPickerProps}
 * @returns 提及选择器浮层
 */
export function MentionPicker({ open, onClose, onSelect }: MentionPickerProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);

  // 按 z_index 倒序，顶层元素优先展示，与图层列表一致
  const ordered = useMemo(
    () => [...nodes].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0)),
    [nodes],
  );

  return (
    <Popover open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {/* 无尺寸锚点：浮层定位以输入框容器为参照，由父级包裹 */}
      <PopoverAnchor />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={12}
        // 防止打开时把焦点从 textarea 抢走，保证 @ 之后可继续输入
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-72 p-1"
      >
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{t('chat.mention')}</p>
        {ordered.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            画布暂无可提及的元素
          </div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {ordered.map((node) => {
              const Icon = TYPE_ICON[node.data.type];
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => {
                    // 构造提及并交还父级，随后关闭浮层
                    onSelect(toMention(node));
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{mentionLabel(node)}</span>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
