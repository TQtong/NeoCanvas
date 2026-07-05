'use client';

/**
 * 底部工具栏（第 01 篇、第 04 篇 4.9）。
 *
 * 画布底部居中悬浮的工具栏，从左到右：选择 / 抓手 / 上传媒体 / 画板 / 网格 / 形状 /
 * 手绘 / 文本 / AI 图像 / AI 视频 / AI 文本。「上传媒体」接受本地图片与视频，「画板」只负责
 * 放置画板节点，「网格」为独立
 * 按钮、循环切换画布网格三态（点状 / 线状 / 无），二者互不相干；最后三个调起对应模态的
 * 生成。当前激活工具 / 网格开启时高亮。
 *
 * @module components/canvas/CanvasBottomToolbar
 */

import {
  Brush,
  Clapperboard,
  Frame,
  Grid3x3,
  Hand,
  MousePointer2,
  Sparkles,
  Square,
  Type,
  Upload,
  WandSparkles,
} from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';
import { useCanvasStore, type CanvasTool } from '@/stores/canvas-store';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';

/** 工具栏属性。 */
export interface CanvasBottomToolbarProps {
  /** 触发本地媒体（图片 / 视频）上传。 */
  onUploadMedia: () => void;
  /** 调起 AI 生成（按模态）。 */
  onAiTool: (modality: 'image' | 'video' | 'text') => void;
}

/** 工具配置项。 */
interface ToolConfig {
  tool: CanvasTool;
  icon: LucideIcon;
  labelKey: string;
}

/** 前七个画布工具。 */
const CANVAS_TOOLS: ToolConfig[] = [
  { tool: 'select', icon: MousePointer2, labelKey: 'tool.select' },
  { tool: 'pan', icon: Hand, labelKey: 'tool.pan' },
  { tool: 'upload-media', icon: Upload, labelKey: 'tool.uploadMedia' },
  { tool: 'frame', icon: Frame, labelKey: 'tool.frame' },
  { tool: 'shape', icon: Square, labelKey: 'tool.shape' },
  { tool: 'draw', icon: Brush, labelKey: 'tool.draw' },
  { tool: 'text', icon: Type, labelKey: 'tool.text' },
];

/** 后三个 AI 工具。 */
const AI_TOOLS: Array<ToolConfig & { modality: 'image' | 'video' | 'text' }> = [
  { tool: 'ai-image', icon: Sparkles, labelKey: 'tool.aiImage', modality: 'image' },
  { tool: 'ai-video', icon: Clapperboard, labelKey: 'tool.aiVideo', modality: 'video' },
  { tool: 'ai-text', icon: WandSparkles, labelKey: 'tool.aiText', modality: 'text' },
];

/**
 * 底部工具栏组件。
 */
export function CanvasBottomToolbar({ onUploadMedia, onAiTool }: CanvasBottomToolbarProps) {
  const { t } = useTranslation();
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setTool = useCanvasStore((s) => s.setTool);
  const cycleBackground = useCanvasStore((s) => s.cycleBackground);
  // 网格按钮的激活态：画布网格非「无」时高亮
  const gridVisible = useCanvasStore((s) => s.background.variant !== 'none');

  const handleCanvasTool = (tool: CanvasTool) => {
    if (tool === 'upload-media') {
      onUploadMedia();
      return;
    }
    // 画板工具只负责放置画板；网格切换已拆为独立的「网格」按钮，二者互不相干
    setTool(tool);
  };

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-30 -translate-x-1/2">
      <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
        {CANVAS_TOOLS.map(({ tool, icon: Icon, labelKey }) => (
          <Fragment key={tool}>
            <Tooltip content={t(labelKey)}>
              <IconButton
                label={t(labelKey)}
                active={activeTool === tool}
                onClick={() => handleCanvasTool(tool)}
              >
                <Icon />
              </IconButton>
            </Tooltip>

            {/* 网格：独立按钮，紧邻画板。点击循环切换画布网格三态（点状 / 线状 / 无），
                与「画板」彻底分开——画板只放画板，网格只管网格 */}
            {tool === 'frame' ? (
              <Tooltip content={t('tool.grid')}>
                <IconButton
                  label={t('tool.grid')}
                  active={gridVisible}
                  onClick={() => cycleBackground()}
                >
                  <Grid3x3 />
                </IconButton>
              </Tooltip>
            ) : null}
          </Fragment>
        ))}

        <div className="mx-1 h-6 w-px bg-border" />

        {AI_TOOLS.map(({ tool, icon: Icon, labelKey, modality }) => (
          <Tooltip key={tool} content={t(labelKey)}>
            <IconButton
              label={t(labelKey)}
              active={activeTool === tool}
              className="text-accent hover:text-accent"
              onClick={() => onAiTool(modality)}
            >
              <Icon />
            </IconButton>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
