'use client';

/**
 * 骨架屏：加载态以微光骨架呈现（第 04 篇第九节）。
 *
 * @module components/ui/skeleton
 */

import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * 骨架块。以 `.skeleton` 微光样式呈现，尺寸由传入 className 控制。
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton rounded-lg', className)} {...rest} />;
}
