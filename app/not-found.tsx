/**
 * 404 页（第 04 篇第九节）。
 *
 * @module app/not-found
 */

import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * 未找到页。
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <h2 className="text-2xl font-semibold">页面不存在</h2>
      <p className="text-sm text-muted-foreground">该项目可能已被删除，或链接无效。</p>
      <Link href="/">
        <Button>返回主页</Button>
      </Link>
    </div>
  );
}
