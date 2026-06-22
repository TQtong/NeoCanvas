'use client';

/**
 * 图标按钮：仅含图标的方形按钮，广泛用于工具栏、控件簇、面板控制。
 *
 * @module components/ui/icon-button
 */

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

/** 图标按钮尺寸。 */
export type IconButtonSize = 'sm' | 'md' | 'lg';

/** 图标按钮属性。 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 尺寸。 */
  size?: IconButtonSize;
  /** 是否处于激活态（如当前选中工具）。 */
  active?: boolean;
  /** 无障碍标签（必填，因无可见文字）。 */
  label: string;
}

const SIZE_CLASS: Record<IconButtonSize, string> = {
  sm: 'size-7 rounded-md [&_svg]:size-4',
  md: 'size-9 rounded-lg [&_svg]:size-[18px]',
  lg: 'size-11 rounded-xl [&_svg]:size-5',
};

/**
 * 图标按钮组件。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size = 'md', active = false, label, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center justify-center text-muted-foreground transition-colors duration-150',
        'hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        active && 'bg-accent-muted text-accent hover:bg-accent-muted hover:text-accent',
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
