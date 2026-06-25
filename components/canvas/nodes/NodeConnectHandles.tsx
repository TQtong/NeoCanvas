'use client';

/**
 * 序列连接桩（第 04 篇画布连线）。
 *
 * 仅挂载于可参与「工作流序列」的图片 / 视频节点：左侧为入桩（target，接收上一帧），
 * 右侧为出桩（source，连向下一帧）。左→右的方向即关键帧顺序，与「逐段首尾帧」视频合成
 * 的链方向一致。
 *
 * 桩默认半透明可见、悬停或选中时凸显，并以 `title` 提示用途——必须显式覆盖 `globals.css`
 * 对 `.react-flow__handle` 的全局 `opacity:0 / pointer-events:none`（原为隐藏血缘连线点而设），
 * 否则桩既不可见也无法拖拽连接。
 *
 * 须作为节点根的直接子节点渲染（在内容裁剪容器之外），避免被 `overflow-hidden` 截断。
 *
 * @module components/canvas/nodes/NodeConnectHandles
 */

import { Handle, Position } from '@xyflow/react';
import { cn } from '@/lib/utils/cn';
import { SEQUENCE_HANDLE_IN, SEQUENCE_HANDLE_OUT } from '@/lib/canvas/sequence';

/** 连接桩属性。 */
export interface NodeConnectHandlesProps {
  /** 节点是否选中（选中时高亮桩）。 */
  selected: boolean;
}

/**
 * 桩通用类名：清晰可见的强调色端口圆点，悬停放大并填充。
 *
 * 关键：
 * - `!z-20` 把桩提到节点内容之上，确保整个圆点可命中（否则被内容盖住，点击漏到画布致框选）；
 * - `!pointer-events-auto` 与 `!opacity-*` 覆盖 globals.css 的全局隐藏规则
 *   （`.react-flow__handle { opacity:0; pointer-events:none }`），使桩可见且可拖拽。
 */
function handleClass(selected: boolean): string {
  return cn(
    '!z-20 !size-4 !rounded-full !border-2 !border-accent !bg-card !shadow-soft',
    // 不用 transform/scale：会覆盖 React Flow 对桩的 translate(-50%) 定位致错位；改用配色反馈
    '!pointer-events-auto !transition-colors hover:!border-accent hover:!bg-accent',
    selected ? '!opacity-100' : '!opacity-90',
  );
}

/**
 * 序列入 / 出连接桩。
 */
export function NodeConnectHandles({ selected }: NodeConnectHandlesProps) {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        id={SEQUENCE_HANDLE_IN}
        className={handleClass(selected)}
        title="序列入点：从上一张图连入"
      />
      <Handle
        type="source"
        position={Position.Right}
        id={SEQUENCE_HANDLE_OUT}
        className={handleClass(selected)}
        title="拖动连接下一张图，串成视频序列"
      />
    </>
  );
}
