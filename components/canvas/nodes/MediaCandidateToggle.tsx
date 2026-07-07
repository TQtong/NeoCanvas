'use client';

/**
 * 媒体候选显隐按钮。
 *
 * 挂在主图片 / 主视频节点上，直接控制该主媒体的全部候选历史节点与候选关系线显隐。
 *
 * @module components/canvas/nodes/MediaCandidateToggle
 */

import { Eye, EyeOff } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvas-store';
import { cn } from '@/lib/utils/cn';

export interface MediaCandidateToggleProps {
  /** 主媒体节点 id。 */
  targetId: string;
  /** 当前是否收起候选。 */
  collapsed: boolean;
}

/** 主媒体候选显隐按钮。 */
export function MediaCandidateToggle({ targetId, collapsed }: MediaCandidateToggleProps) {
  const candidateCount = useCanvasStore(
    (s) =>
      s.nodes.filter((node) => {
        if (node.data.type === 'image' || node.data.type === 'video') {
          return node.data.candidateOf === targetId;
        }
        if (node.data.type === 'generation_placeholder') {
          return (
            node.data.resultMode === 'candidate_for_target' && node.data.targetNodeId === targetId
          );
        }
        return false;
      }).length,
  );
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  if (candidateCount === 0) return null;

  const label = collapsed ? `展开 ${candidateCount} 个候选` : `收起 ${candidateCount} 个候选`;
  const Icon = collapsed ? Eye : EyeOff;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'nodrag nopan absolute right-2 top-2 z-20 flex h-7 max-w-[calc(100%-16px)] items-center gap-1.5 rounded-md border border-border bg-background/90 px-2 text-[11px] font-medium text-foreground shadow-soft backdrop-blur transition-colors hover:bg-muted',
        collapsed && 'border-accent/50 bg-accent/10 text-accent',
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        updateNodeData(targetId, { candidatesCollapsed: !collapsed });
      }}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">候选 {candidateCount}</span>
    </button>
  );
}
