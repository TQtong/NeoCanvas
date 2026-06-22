'use client';

/**
 * 文本节点（第 04 篇 4.4）。
 *
 * 渲染可就地编辑的文本框，承载字体 / 字号 / 字重 / 行高 / 对齐 / 颜色等排版属性。双击
 * 进入编辑态：以 textarea 覆盖编辑，拦截画布拖拽与快捷键以免冲突；失焦 / Esc 退出。
 *
 * @module components/canvas/nodes/TextNode
 */

import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { TextNodeData } from '@/types';
import type { CanvasFlowNode } from '@/lib/canvas/node-mapper';
import { useCanvasStore } from '@/stores/canvas-store';
import { TransformableNode } from '../TransformableNode';

function TextNodeComponent({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const d = data as TextNodeData;
  const editingNodeId = useCanvasStore((s) => s.editingNodeId);
  const setEditingNode = useCanvasStore((s) => s.setEditingNode);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editing = editingNodeId === id;

  // 进入编辑态时聚焦并将光标置于末尾
  useLayoutEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  // 空文本节点新建后自动进入编辑（首次挂载且无内容时）
  useEffect(() => {
    if (!d.text && selected && editingNodeId === null) {
      setEditingNode(id);
    }
    // 仅在挂载时尝试，避免反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const textStyle: React.CSSProperties = {
    fontFamily: d.fontFamily,
    fontSize: d.fontSize,
    fontWeight: d.fontWeight,
    lineHeight: d.lineHeight,
    letterSpacing: d.letterSpacing,
    textAlign: d.align,
    color: d.color,
    fontStyle: d.italic ? 'italic' : 'normal',
    textDecoration: d.underline ? 'underline' : 'none',
    backgroundColor: d.backgroundColor === 'transparent' ? undefined : d.backgroundColor,
    whiteSpace: d.autoWrap ? 'pre-wrap' : 'pre',
    wordBreak: d.autoWrap ? 'break-word' : 'normal',
  };

  return (
    <TransformableNode
      id={id}
      selected={Boolean(selected)}
      rotation={d.rotation}
      enableRotate={!editing}
      enableResize={!editing}
    >
      <div
        className="size-full cursor-text overflow-hidden p-1"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditingNode(id);
        }}
      >
        {editing ? (
          <textarea
            ref={textareaRef}
            value={d.text}
            onChange={(e) => updateNodeData(id, { text: e.target.value })}
            onBlur={() => setEditingNode(null)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditingNode(null);
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag nopan size-full resize-none border-none bg-transparent outline-none"
            style={textStyle}
            spellCheck={false}
          />
        ) : (
          <div className="size-full" style={textStyle}>
            {d.text || <span className="text-muted-foreground/60">双击编辑文本</span>}
          </div>
        )}
      </div>
    </TransformableNode>
  );
}

/** 记忆化文本节点。 */
export const TextNode = memo(TextNodeComponent);
