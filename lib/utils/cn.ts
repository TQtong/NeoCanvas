import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 className：先以 clsx 处理条件类，再以 tailwind-merge 消解 Tailwind 冲突类。
 *
 * @param inputs - 任意 className 片段（字符串、对象、数组）
 * @returns 合并去重后的 className 字符串
 *
 * @example
 *   cn('px-2', condition && 'px-4') // condition 为真时得到 'px-4'
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
