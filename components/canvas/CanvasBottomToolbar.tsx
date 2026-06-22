'use client';

/**
 * 底部工具栏（第 01 篇、第 04 篇 4.9）。
 *
 * 画布底部居中悬浮的十工具栏，从左到右：选择 / 抓手 / 上传图片 / 画板网格 / 形状 /
 * 手绘 / 文本 / AI 图像 / AI 视频 / AI 文本。前七个切换交互模式或触发创建，后三个调起
 * 对应模态的生成。当前激活工具高亮。
 *
 * @module components/canvas/CanvasBottomToolbar
 */

import {
  Brush,
  Clapperboard,
  Frame,
  Hand,
  ImageUp,
  MousePointer2,
  Sparkles,
  Square,
  Type,
  WandSparkles,
} from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { useCanvasStore, type CanvasTool } from '@/stores/canvas-store';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';

/** 工具栏属性。 */
export interface CanvasBottomToolbarProps {
  /** 触发本地图片上传。 */
  onUploadImage: () => void;
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
  { tool: 'upload-image', icon: ImageUp, labelKey: 'tool.uploadImage' },
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
export function CanvasBottomToolbar({ onUploadImage, onAiTool }: CanvasBottomToolbarProps) {
  const { t } = useTranslation();
  const activeTool = useCanvasStore((s) => s.activeTool);
  const setTool = useCanvasStore((s) => s.setTool);

  const handleCanvasTool = (tool: CanvasTool) => {
    if (tool === 'upload-image') {
      onUploadImage();
      return;
    }
    setTool(tool);
  };

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-30 -translate-x-1/2">
      <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
        {CANVAS_TOOLS.map(({ tool, icon: Icon, labelKey }) => (
          <Tooltip key={tool} content={t(labelKey)}>
            <IconButton
              label={t(labelKey)}
              active={activeTool === tool}
              onClick={() => handleCanvasTool(tool)}
            >
              <Icon />
            </IconButton>
          </Tooltip>
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
