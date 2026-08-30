'use client';

/**
 * 画布键盘快捷键（第 01 篇第六节）。
 *
 * 覆盖：C 聚焦对话、V 选择、H 抓手、R 矩形、T 文本、P 画笔、F 画板、Delete 删除、
 * Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z 重做、Cmd/Ctrl+C/V 复制粘贴、Cmd/Ctrl+D 复制、
 * Cmd/Ctrl+A 全选、Esc 清除选择 / 退出工具。焦点位于输入框 / 文本编辑时不拦截。
 *
 * @module components/canvas/use-canvas-shortcuts
 */

import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvas-store';
import type { UseCanvasHistory } from './use-canvas-history';

/** 判断焦点是否在可编辑元素中。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * 装配画布快捷键。
 *
 * @param history - 撤销 / 重做动作
 * @param disabled - 模态编辑器打开时暂停画布级快捷键
 */
export function useCanvasShortcuts(history: UseCanvasHistory, disabled = false): void {
  const reactFlow = useReactFlow();

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const store = useCanvasStore.getState();
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // React Flow 的内部选中状态与画布 Zustand 快照可能短暂不同步，显式处理删除键。
      if (!meta && (key === 'delete' || key === 'backspace')) {
        if (store.selectedNodeIds.length > 0) {
          event.preventDefault();
          store.removeNodes(store.selectedNodeIds);
        }
        return;
      }

      // 组合键
      if (meta) {
        switch (key) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) history.redo();
            else history.undo();
            return;
          case 'y':
            event.preventDefault();
            history.redo();
            return;
          // 缩放：Cmd/Ctrl + = / + 放大，- 缩小，0 适应画布（第 04 篇 4.3）
          case '=':
          case '+':
            event.preventDefault();
            void reactFlow.zoomIn({ duration: 150 });
            return;
          case '-':
          case '_':
            event.preventDefault();
            void reactFlow.zoomOut({ duration: 150 });
            return;
          case '0':
            event.preventDefault();
            void reactFlow.fitView({ padding: 0.2, duration: 250 });
            return;
          case 'c':
            store.copySelection();
            return;
          case 'v':
            event.preventDefault();
            store.paste();
            return;
          case 'd':
            event.preventDefault();
            store.duplicateSelection();
            return;
          case 'a':
            event.preventDefault();
            store.selectAll();
            return;
          case 'g':
            // 成组（多选）/ 解组（选中组容器）：Cmd/Ctrl+G、Cmd/Ctrl+Shift+G
            event.preventDefault();
            if (event.shiftKey) store.ungroupSelection();
            else store.groupSelection();
            return;
          default:
            return;
        }
      }

      // 单键工具切换与动作
      switch (key) {
        case 'v':
          store.setTool('select');
          break;
        case 'h':
          store.setTool('pan');
          break;
        case 'r':
          store.setTool('shape');
          break;
        case 't':
          store.setTool('text');
          break;
        case 'p':
          store.setTool('draw');
          break;
        case 'f':
          store.setTool('frame');
          break;
        case 'escape':
          store.clearSelection();
          store.setEditingNode(null);
          store.setTool('select');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [disabled, history, reactFlow]);
}
