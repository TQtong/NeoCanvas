'use client';

/** Flow 左侧可搜索节点库。 */

import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import type { WorkflowNodeKind } from '@/types';
import { WORKFLOW_NODE_DEFINITIONS, type WorkflowNodeCategory } from '@/lib/workflow/registry';
import { cn } from '@/lib/utils/cn';

const CATEGORY_LABELS: Record<WorkflowNodeCategory, string> = {
  input: '输入',
  transform: '组织',
  image: '图片',
  video: '视频',
  output: '输出',
  utility: '辅助',
};

export function NodeLibrary({ onAdd }: { onAdd: (kind: WorkflowNodeKind) => void }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return Object.entries(CATEGORY_LABELS)
      .map(([category, label]) => ({
        category: category as WorkflowNodeCategory,
        label,
        nodes: WORKFLOW_NODE_DEFINITIONS.filter(
          (definition) =>
            definition.category === category &&
            (!normalized ||
              `${definition.title} ${definition.description} ${definition.kind}`
                .toLowerCase()
                .includes(normalized)),
        ),
      }))
      .filter((group) => group.nodes.length > 0);
  }, [query]);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border p-3">
        <h2 className="mb-2 text-sm font-semibold text-foreground">节点库</h2>
        <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <section key={group.category} className="mb-4">
            <h3 className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </h3>
            <div className="space-y-1">
              {group.nodes.map((definition) => (
                <button
                  key={definition.kind}
                  type="button"
                  onClick={() => onAdd(definition.kind)}
                  className={cn(
                    'group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                    'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
                    <Plus className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground">
                      {definition.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-muted-foreground">
                      {definition.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}
