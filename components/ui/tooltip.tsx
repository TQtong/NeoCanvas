'use client';

/**
 * 工具提示（基于 Radix Tooltip），用于工具栏与控件的可读名称提示。
 *
 * @module components/ui/tooltip
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/** 全局 Tooltip Provider。在根布局包裹一次。 */
export const TooltipProvider = TooltipPrimitive.Provider;

/** 简易 Tooltip 属性。 */
export interface TooltipProps {
  /** 触发元素。 */
  children: ReactNode;
  /** 提示内容。 */
  content: ReactNode;
  /** 显示方位。 */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** 与触发元素的偏移。 */
  sideOffset?: number;
  /** 是否禁用提示。 */
  disabled?: boolean;
}

/**
 * 简易工具提示包装。
 */
export function Tooltip({
  children,
  content,
  side = 'top',
  sideOffset = 8,
  disabled,
}: TooltipProps) {
  if (disabled) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={sideOffset}
          className={cn(
            'z-[80] animate-scale-in rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-float',
            'select-none',
          )}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-foreground" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
