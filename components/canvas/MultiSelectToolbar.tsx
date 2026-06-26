'use client';

/**
 * 多选浮动工具条（第 04 篇 4.6 组操作）。
 *
 * 选中 ≥2 个节点时，在选择集包围盒上方浮现一条工具条（借助 {@link NodeToolbar} 传入选中 id
 * 数组自动定位、随平移 / 缩放跟随，类 PPT 就近操作）：
 * - 选区尚未成组 → 显示「成组」（给成员打同一 groupId，无容器）；
 * - 选区已是一个完整的组（成员共享同一 groupId）→ 显示「解组」（清除标记）。
 *
 * @module components/canvas/MultiSelectToolbar
 */

import { NodeToolbar, Position } from '@xyflow/react';
import { Group, Ungroup } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvas-store';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';

/**
 * 多选浮动工具条。须置于 ReactFlow 内。
 */
export function MultiSelectToolbar() {
  const { t } = useTranslation();
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds);
  const nodes = useCanvasStore((s) => s.nodes);
  const groupSelection = useCanvasStore((s) => s.groupSelection);
  const ungroupSelection = useCanvasStore((s) => s.ungroupSelection);

  if (selectedNodeIds.length < 2) return null;

  const selected = nodes.filter((n) => selectedNodeIds.includes(n.id));
  // 选区是否已是一个完整的组：全部成员共享同一个（已定义的）groupId
  const groupIds = new Set(selected.map((n) => n.data.groupId));
  const isGroup = groupIds.size === 1 && !groupIds.has(undefined);

  const label = isGroup ? t('node.ungroup') : t('node.group');
  const Icon = isGroup ? Ungroup : Group;

  return (
    <NodeToolbar nodeId={selectedNodeIds} isVisible position={Position.Top} offset={12}>
      <div className="glass flex items-center gap-0.5 rounded-xl p-1">
        <Tooltip content={label}>
          <button
            type="button"
            onClick={() => (isGroup ? ungroupSelection() : groupSelection())}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent-muted"
          >
            <Icon className="size-4" />
            {label}
          </button>
        </Tooltip>
      </div>
    </NodeToolbar>
  );
}
