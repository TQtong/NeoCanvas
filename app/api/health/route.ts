/**
 * 应用进程健康检查。
 *
 * 该端点只证明 Next.js 进程已经完成启动并能够处理请求，不读取数据库、会话或任何
 * 私有环境变量。容器编排与 Playwright 使用它等待应用就绪，避免把受保护页面的重定向
 * 误判为健康状态。
 *
 * @module app/api/health/route
 */

import { NextResponse } from 'next/server';

/** 健康检查不缓存，确保每次都命中当前应用进程。 */
export const dynamic = 'force-dynamic';

/**
 * 返回稳定、无敏感信息的健康状态。
 *
 * @returns HTTP 200 健康响应
 */
export function GET(): NextResponse {
  return NextResponse.json(
    { status: 'ok', service: 'neocanvas-web' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
