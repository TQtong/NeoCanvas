'use client';

/**
 * 轻量图层列表（第 04 篇 4.7）。
 *
 * 按 z_index 倒序展示当前画布元素（类型图标 + 名称 / 摘要），支持点选定位与上移 / 下移
 * 改序。刻意不做成完整图层树编辑器（不含分组、嵌套、逐项可见性管理）。
 *
 * @module components/canvas/LayersList
 */

import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  ChevronDown,
  ChevronUp,
  Frame,
  ImageIcon,
  PenLine,
  Shapes,
  Sparkles,
  Type,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useCanvasStore } from '@/stores/canvas-store';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import type { NodeType } from '@/types';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils/cn';

const TYPE_ICON: Record<NodeType, LucideIcon> = {
  image: ImageIcon,
  text: Type,
  shape: Shapes,
  drawing: PenLine,
  video: Video,
  generation_placeholder: Sparkles,
  frame: Frame,
};

/** 取节点的展示名。 */
function nodeLabel(node: CanvasFlowNode): string {
  const data = node.data;
  switch (data.type) {
    case 'text':
      return data.text.trim().slice(0, 24) || '文本';
    case 'image':
      return '图片';
    case 'video':
      return '视频';
    case 'shape':
      return '形状';
    case 'drawing':
      return '手绘';
    case 'frame':
      return data.name || '画板';
    case 'generation_placeholder':
      return data.promptSummary.slice(0, 24) || '生成中';
    default:
      return '元素';
  }
}

/**
 * 图层列表组件。
 */
export function LayersList() {
  const reactFlow = useReactFlow();
  const nodes = useCanvasStore((s) => s.nodes);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const setSelection = useCanvasStore((s) => s.setSelection);
  const moveForward = useCanvasStore((s) => s.moveForward);
  const moveBackward = useCanvasStore((s) => s.moveBackward);

  // 按 z_index 倒序（顶层在上）
  const ordered = useMemo(
    () => [...nodes].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0)),
    [nodes],
  );

  if (ordered.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground">画布暂无元素</div>;
  }

  return (
    <div className="max-h-72 overflow-y-auto p-1">
      {ordered.map((node) => {
        const Icon = TYPE_ICON[node.data.type];
        const selected = selectedNodeIds.includes(node.id);
        return (
          <div
            key={node.id}
            className={cn(
              'group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors',
              selected ? 'bg-accent-muted text-accent' : 'hover:bg-muted',
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => {
                setSelection([node.id]);
                reactFlow.fitView({ padding: 0.5, duration: 250, nodes: [{ id: node.id }] });
              }}
            >
              <Icon className="size-4 shrink-0 opacity-70" />
              <span className="truncate">{nodeLabel(node)}</span>
            </button>
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              <IconButton size="sm" label="上移一层" onClick={() => moveForward([node.id])}>
                <ChevronUp />
              </IconButton>
              <IconButton size="sm" label="下移一层" onClick={() => moveBackward([node.id])}>
                <ChevronDown />
              </IconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}
