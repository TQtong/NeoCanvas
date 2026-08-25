'use client';

/**
 * Agent 模式下拉（第 04 篇第六节）。
 *
 * 对话输入区右下角的工作模式切换：在 Generate（纯生成）/ Agent（编排）/ Scene（场景流程）
 * 之间选择。当前模式取自对话状态库，候选来自静态清单 {@link AGENT_MODE_ENTRIES}；模式
 * 标签保留英文原文以贴合草图，描述走 t() 本地化。
 *
 * @module components/chat/AgentModeDropdown
 */

import { Check, ChevronDown } from 'lucide-react';
import type { ModelCatalogEntry } from '@/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AGENT_MODE_ENTRIES } from '@/lib/models/catalog';
import { useChatStore } from '@/stores/chat-store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils/cn';

/**
 * Agent 模式下拉组件。
 *
 * 无 props：当前模式与切换动作均经对话状态库读写，可在对话输入区直接挂载。
 *
 * @returns Agent 模式下拉
 */
export function AgentModeDropdown({ models }: { models: ModelCatalogEntry[] }) {
  const { t } = useTranslation();
  // 订阅当前模式与切换动作
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const selectedModelKey = useChatStore((s) => s.selectedModelKey);
  const setModel = useChatStore((s) => s.setModel);

  // 当前模式对应的清单条目（用于触发器展示英文标签）；清单恒非空，未命中以 Generate 兜底
  const current = AGENT_MODE_ENTRIES.find((entry) => entry.mode === agentMode) ?? {
    mode: 'generate' as const,
    label: 'Generate',
    description: 'agent.generate.desc',
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 select-none items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium',
            'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'data-[state=open]:bg-muted data-[state=open]:text-foreground',
          )}
        >
          {/* 模式标签保留英文原文 */}
          <span>{current.label}</span>
          <ChevronDown className="size-4 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-[15rem]">
        <DropdownMenuLabel>{t('home.selectModel')}</DropdownMenuLabel>
        {models.length > 0 ? (
          models.map((model) => (
            <DropdownMenuItem
              key={model.key}
              onClick={() => setModel(model.key)}
              className="justify-between gap-3"
            >
              <span className="min-w-0 truncate">{model.displayName}</span>
              {model.key === selectedModelKey ? (
                <Check className="size-4 shrink-0 !text-accent" />
              ) : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>{t('home.noAvailableModels')}</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('chat.agentMode')}</DropdownMenuLabel>
        {AGENT_MODE_ENTRIES.map((entry) => {
          const active = entry.mode === agentMode;
          return (
            <DropdownMenuItem
              key={entry.mode}
              onClick={() => setAgentMode(entry.mode)}
              className="items-start gap-2.5"
            >
              {/* 选中态打勾，未选中以零透明占位保持对齐；强调色经 !text-accent 压过菜单项的图标默认色 */}
              <Check
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  active ? '!text-accent opacity-100' : 'opacity-0',
                )}
              />
              <span className="flex min-w-0 flex-col">
                {/* 模式标签保留英文原文 */}
                <span className="font-medium text-foreground">{entry.label}</span>
                <span className="text-xs text-muted-foreground">{t(entry.description)}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
