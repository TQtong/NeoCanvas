/**
 * 全局加载态（第 04 篇第九节）。
 *
 * @module app/loading
 */

import { Spinner } from '@/components/ui/spinner';

/**
 * 加载占位。
 */
export default function Loading() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center">
      <Spinner className="size-7 text-accent" />
    </div>
  );
}
