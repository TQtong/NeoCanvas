'use client';

/**
 * 转圈指示器。
 *
 * @module components/ui/spinner
 */

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/** 转圈属性。 */
export interface SpinnerProps {
  /** 额外类名（控制尺寸与颜色）。 */
  className?: string;
  /** 无障碍标签。 */
  label?: string;
}

/**
 * 转圈组件。
 */
export function Spinner({ className, label = '加载中' }: SpinnerProps) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn('size-5 animate-spin text-muted-foreground', className)}
    />
  );
}
