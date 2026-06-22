'use client';

/**
 * 下拉菜单（基于 Radix DropdownMenu），用于头像菜单、节点工具条次级操作、卡片悬停操作。
 *
 * @module components/ui/dropdown-menu
 */

import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils/cn';

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;

/** 下拉菜单内容面板。 */
export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'glass z-[90] min-w-[10rem] animate-scale-in overflow-hidden rounded-xl p-1.5 shadow-float',
          className,
        )}
        {...rest}
      />
    </DropdownPrimitive.Portal>
  );
});

/** 下拉菜单项。 */
export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { destructive?: boolean }
>(function DropdownMenuItem({ className, destructive, ...rest }, ref) {
  return (
    <DropdownPrimitive.Item
      ref={ref}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors',
        'focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[&_svg]:size-4 [&_svg]:text-muted-foreground',
        destructive && 'text-danger focus:bg-danger/10 [&_svg]:text-danger',
        className,
      )}
      {...rest}
    />
  );
});

/** 分隔线。 */
export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <DropdownPrimitive.Separator className={cn('my-1 h-px bg-border', className)} />;
}

/** 标签。 */
export function DropdownMenuLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <DropdownPrimitive.Label className={cn('px-2.5 py-1.5 text-xs text-muted-foreground', className)}>
      {children}
    </DropdownPrimitive.Label>
  );
}
