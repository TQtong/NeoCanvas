'use client';

/**
 * 生成占位节点（第 04 篇 4.4、第 05 篇第五节）。
 *
 * 渲染带进度与提示词摘要的占位卡片，订阅其关联生成任务的进度（经 Realtime 注入
 * `data.progress` / `data.statusLabel`）。成功后该节点被原地转化为 image / video 节点；
 * 失败时呈现可重试态。
 *
 * @module components/canvas/nodes/GenerationPlaceholderNode
 */

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { ImageIcon, RotateCcw, TriangleAlert, Video } from 'lucide-react';
import type { GenerationPlaceholderNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { useCanvasStore } from '@/stores/canvas-store';
import { useGeneration } from '@/lib/hooks/use-generation';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';

function GenerationPlaceholderNodeComponent({ id, data }: NodeProps<CanvasFlowNode>) {
  const d = data as GenerationPlaceholderNodeData;
  const { t } = useTranslation();
  const { retry } = useGeneration();
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const nodes = useCanvasStore((s) => s.nodes);

  const failed = d.statusLabel === 'failed';
  const progress = Math.max(0, Math.min(100, d.progress ?? 0));
  const Icon = d.targetModality === 'video' ? Video : ImageIcon;

  const onRetry = async () => {
    if (!d.generationId) return;
    const self = nodes.find((n) => n.id === id);
    const placement = self
      ? {
          x: self.position.x,
          y: self.position.y,
          width: typeof self.width === 'number' ? self.width : d.targetWidth,
          height: typeof self.height === 'number' ? self.height : d.targetHeight,
        }
      : undefined;
    removeNodes([id]);
    await retry(d.generationId, placement);
  };

  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border p-4 text-center',
        failed ? 'border-danger/40 bg-danger/5' : 'border-dashed border-accent/40 bg-accent-muted/40',
      )}
    >
      {failed ? (
        <>
          <TriangleAlert className="size-7 text-danger" />
          <p className="text-sm font-medium text-danger">{t('node.generationFailed')}</p>
          {d.errorMessage ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{d.errorMessage}</p>
          ) : null}
          <button
            type="button"
            onClick={onRetry}
            className="nodrag inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-danger-foreground transition-opacity hover:opacity-90"
          >
            <RotateCcw className="size-3.5" />
            {t('common.retry')}
          </button>
        </>
      ) : (
        <>
          <Icon className="size-7 animate-pulse-soft text-accent" />
          <p className="text-sm font-medium text-accent">{t('node.generating')}</p>
          {d.promptSummary ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{d.promptSummary}</p>
          ) : null}
          <div className="h-1.5 w-full max-w-[80%] overflow-hidden rounded-full bg-accent/15">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{progress}%</span>
        </>
      )}
    </div>
  );
}

/** 记忆化生成占位节点。 */
export const GenerationPlaceholderNode = memo(GenerationPlaceholderNodeComponent);
