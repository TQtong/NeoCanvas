'use client';

/**
 * 文字节点的「描述出桩」（第 04 篇画布连线）。
 *
 * 文字节点右侧的单个 source 连接桩：拖一条线连到某张图片 / 视频节点，即把该文字作为这张图的
 * 「描述 / 提示词」（{@link lib/canvas/annotation} 的 annotation 边）。为不打扰纯设计文本，
 * 桩默认随全局规则隐藏，仅在悬停节点或选中时显现。
 *
 * 须作为节点根的直接子节点、渲染在内容之后（DOM 靠后 + z-20），确保整圆点可命中、可拖拽。
 *
 * @module components/canvas/nodes/TextConnectHandle
 */

import { Handle, Position } from '@xyflow/react';
import { cn } from '@/lib/utils/cn';
import { ANNOTATION_HANDLE_OUT } from '@/lib/canvas/annotation';

/** 描述出桩属性。 */
export interface TextConnectHandleProps {
  /** 节点是否选中（选中时常显桩）。 */
  selected: boolean;
}

/**
 * 描述出桩类名：中性色小圆点，悬停转强调色。
 *
 * `!z-20` + `!pointer-events-auto` 覆盖 globals.css 的全局隐藏规则，使桩可命中、可拖拽；
 * 默认 `!opacity-0`（由 `.react-flow__node:hover .react-flow__handle` 悬停显现），选中时常显。
 */
function handleClass(selected: boolean): string {
  return cn(
    '!z-20 !size-3.5 !rounded-full !border-2 !border-muted-foreground !bg-card !shadow-soft',
    '!pointer-events-auto !transition-colors hover:!border-accent hover:!bg-accent',
    selected ? '!opacity-90' : '!opacity-0',
  );
}

/**
 * 文字节点描述出桩。
 */
export function TextConnectHandle({ selected }: TextConnectHandleProps) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={ANNOTATION_HANDLE_OUT}
      className={handleClass(selected)}
      title="拖动连接到一张图片，作为它的描述 / 提示词"
    />
  );
}
