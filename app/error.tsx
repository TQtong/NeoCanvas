'use client';

/**
 * 全局错误边界（第 04 篇第九节）。给出可读信息与重试入口。
 *
 * @module app/error
 */

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * 错误页。
 *
 * @param props - 错误对象与重置回调
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('页面错误', error);
  }, [error]);

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <h2 className="text-xl font-semibold">出错了</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {error.message || '发生未预期的错误，请重试。'}
      </p>
      <Button onClick={reset}>重试</Button>
    </div>
  );
}
