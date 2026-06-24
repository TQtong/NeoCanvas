/**
 * 设计页加载骨架（第 04 篇第九节）。
 *
 * 作为 /p/[projectId] 路由段的 Suspense 兜底，在服务端预取项目数据期间即时呈现与工作台
 * 同构的「画布 + 对话」双区骨架，而非通用转圈，使导航过渡布局稳定、不闪烁。
 *
 * @module app/p/[projectId]/loading
 */

import { Skeleton } from '@/components/ui/skeleton';

/** 画布区骨架：顶栏 + 网格底 + 若干节点占位 + 底部工具栏 + 左下控件。 */
function CanvasSkeleton() {
  return (
    <div className="relative flex-1">
      {/* 顶栏：项目名 + 右侧操作 */}
      <div className="absolute inset-x-0 top-0 flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-full" />
        </div>
      </div>

      {/* 画布主体：点状网格底 + 几个节点占位 */}
      <div
        className="absolute inset-0 pt-14"
        style={{
          backgroundImage: 'radial-gradient(hsl(var(--muted-foreground) / 0.18) 1.2px, transparent 1.2px)',
          backgroundSize: '24px 24px',
        }}
      >
        <div className="relative size-full">
          <Skeleton className="absolute left-[14%] top-[20%] h-40 w-56 rounded-2xl" />
          <Skeleton className="absolute left-[44%] top-[34%] h-52 w-52 rounded-2xl" />
          <Skeleton className="absolute left-[26%] top-[58%] h-32 w-44 rounded-2xl" />
        </div>
      </div>

      {/* 底部工具栏药丸 */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
        <div className="glass flex items-center gap-1 rounded-2xl p-1.5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="size-9 rounded-lg" />
          ))}
        </div>
      </div>

      {/* 左下控件簇 */}
      <div className="absolute bottom-6 left-4 flex items-center gap-2">
        <Skeleton className="h-9 w-20 rounded-xl" />
        <Skeleton className="size-9 rounded-xl" />
      </div>
    </div>
  );
}

/** 对话区骨架：标题 + 交替宽度的消息气泡 + 底部输入条。 */
function ChatSkeleton() {
  return (
    <aside className="h-full w-[380px] shrink-0 border-l border-border bg-card">
      <div className="flex h-full flex-col">
        {/* 顶栏 */}
        <div className="flex h-[49px] shrink-0 items-center justify-between border-b border-border px-4">
          <Skeleton className="h-4 w-20" />
          <div className="flex gap-1">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="size-7 rounded-lg" />
          </div>
        </div>

        {/* 消息流占位 */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
          <Skeleton className="h-10 w-3/4 self-end rounded-2xl" />
          <Skeleton className="h-20 w-5/6 self-start rounded-2xl" />
          <Skeleton className="h-10 w-2/3 self-end rounded-2xl" />
          <Skeleton className="h-28 w-5/6 self-start rounded-2xl" />
        </div>

        {/* 输入条 */}
        <div className="shrink-0 p-3">
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </div>
    </aside>
  );
}

/**
 * 设计页加载骨架组件。
 */
export default function DesignLoading() {
  return (
    <div className="relative flex h-screen w-full overflow-hidden bg-background">
      <CanvasSkeleton />
      <ChatSkeleton />
    </div>
  );
}
