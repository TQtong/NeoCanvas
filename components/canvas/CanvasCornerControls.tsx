'use client';

/**
 * 左下控件簇（第 01 篇、第 04 篇 4.3/4.7）。
 *
 * 包含：视图模式占位、图层列表入口、定位 / 聚焦元素、缩放比例显示（点击展开预设倍率
 * 与「适应画布」）。刻意保持精简，不构成完整图层树编辑器。
 *
 * @module components/canvas/CanvasCornerControls
 */

import { useCallback } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { Layers, Maximize, MessageSquare, Search } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvas-store';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ZOOM_PRESETS, FIT_VIEW_PADDING } from '@/lib/canvas/constants';
import { formatZoom } from '@/lib/utils/format';
import { useTranslation } from '@/i18n';
import { LayersList } from './LayersList';

/**
 * 左下控件簇组件。须置于 ReactFlowProvider 内。
 */
export function CanvasCornerControls() {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const layersOpen = useCanvasStore((s) => s.layersOpen);
  const toggleLayers = useCanvasStore((s) => s.toggleLayers);
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);

  const setZoom = useCallback(
    (value: number) => {
      reactFlow.zoomTo(value, { duration: 200 });
    },
    [reactFlow],
  );

  const fitView = useCallback(() => {
    reactFlow.fitView({ padding: FIT_VIEW_PADDING, duration: 300 });
  }, [reactFlow]);

  // 聚焦选中元素（无选中则 fitView 全部）
  const focusSelection = useCallback(() => {
    const ids = useCanvasStore.getState().selectedNodeIds;
    if (ids.length > 0) {
      reactFlow.fitView({ padding: 0.4, duration: 300, nodes: ids.map((id) => ({ id })) });
    } else {
      fitView();
    }
  }, [reactFlow, fitView]);

  return (
    <div className="pointer-events-auto absolute bottom-6 left-6 z-30 flex items-center gap-1.5">
      <div className="glass flex items-center gap-0.5 rounded-xl p-1">
        <Tooltip content={t('chat.newConversation')}>
          <IconButton size="sm" label={t('chat.newConversation')}>
            <MessageSquare />
          </IconButton>
        </Tooltip>

        <Popover open={layersOpen} onOpenChange={toggleLayers}>
          <PopoverTrigger asChild>
            <span>
              <Tooltip content={t('design.layers')} disabled={layersOpen}>
                <IconButton size="sm" label={t('design.layers')} active={layersOpen}>
                  <Layers />
                </IconButton>
              </Tooltip>
            </span>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-64 p-0">
            <LayersList />
          </PopoverContent>
        </Popover>

        <Tooltip
          content={selectedNodeIds.length > 0 ? t('design.zoomToFit') : t('design.zoomToFit')}
        >
          <IconButton size="sm" label={t('design.zoomToFit')} onClick={focusSelection}>
            <Search />
          </IconButton>
        </Tooltip>

        <Tooltip content={t('design.zoomToFit')}>
          <IconButton size="sm" label={t('design.zoomToFit')} onClick={fitView}>
            <Maximize />
          </IconButton>
        </Tooltip>
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="glass h-9 rounded-xl px-3 text-sm font-medium tabular-nums text-foreground transition-colors hover:text-accent"
            aria-label={t('design.zoom')}
          >
            {formatZoom(zoom)}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-40 p-1">
          {ZOOM_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setZoom(preset)}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted"
            >
              <span>{formatZoom(preset)}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={fitView}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted"
          >
            <Maximize className="size-4 text-muted-foreground" />
            {t('design.zoomToFit')}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
