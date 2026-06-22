'use client';

/**
 * 浮层（基于 Radix Popover），用于提及选择器、缩放预设、形状/文本属性面板等。
 *
 * @module components/ui/popover
 */

import * as PopoverPrimitive from '@radix-ui/react-popover';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils/cn';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

/** 浮层内容面板。 */
export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'center', sideOffset = 8, ...rest }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'glass z-[90] animate-scale-in rounded-xl p-2 shadow-float outline-none',
          className,
        )}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
});
