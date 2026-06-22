/**
 * 内部函数触发助手。
 *
 * 用于低延迟地从一个 Edge Function 触发另一个内部型函数（如提交后即时唤起队列消费）。
 * 优先用 `EdgeRuntime.waitUntil` 在响应返回后于后台执行，避免阻塞调用方；不可用时回退
 * 为不等待的 fire-and-forget。pg_cron 仍作为兜底周期触发。
 *
 * @module functions/_shared/trigger
 */

/** Supabase Edge 运行时的后台任务接口（声明以便类型检查）。 */
declare const EdgeRuntime:
  | { waitUntil: (promise: Promise<unknown>) => void }
  | undefined;

/**
 * 触发一个内部型 Edge Function（以服务角色鉴权）。
 *
 * @param name - 函数逻辑名
 * @param body - 请求体
 */
export function triggerFunction(name: string, body: Record<string, unknown> = {}): void {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return;

  const task = fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  })
    .then(() => undefined)
    .catch((error) => {
      console.error(`触发 ${name} 失败`, error);
    });

  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(task);
  }
  // 否则不等待，依赖 pg_cron 兜底
}
