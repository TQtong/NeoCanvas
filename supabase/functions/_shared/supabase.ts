/**
 * Supabase 客户端工厂（边缘侧）。
 *
 * - 管理员客户端：以服务角色密钥创建，绕过 RLS，用于可信写入（生成落库、助手消息）。
 * - 用户客户端：以请求中的用户 JWT 创建，受 RLS 约束，用于校验调用者身份与归属。
 *
 * @module functions/_shared/supabase
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { ApiException } from './response.ts';

/** 读取必需环境变量，缺失即抛出。 */
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new ApiException('internal_error', `缺少环境变量 ${name}`);
  }
  return value;
}

/**
 * 创建以服务角色运行的管理员客户端（绕过 RLS）。
 *
 * @returns 管理员 Supabase 客户端
 */
export function createAdminClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * 从请求头取出用户 JWT 并校验，返回调用者用户标识与一个绑定该会话的客户端。
 *
 * @param request - 进入的请求
 * @returns 用户标识与用户态客户端
 * @throws {ApiException} 当缺失 / 失效 JWT 时（unauthorized）
 */
export async function requireUser(
  request: Request,
): Promise<{ userId: string; client: SupabaseClient; token: string }> {
  const authHeader = request.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new ApiException('unauthorized', '缺少授权令牌，请重新登录');
  }

  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    throw new ApiException('unauthorized', '登录态失效，请重新登录');
  }
  return { userId: data.user.id, client, token };
}

/**
 * 校验某项目归属于指定用户（以管理员客户端读取，避免 RLS 干扰）。
 *
 * @param admin - 管理员客户端
 * @param projectId - 项目标识
 * @param userId - 调用者用户标识
 * @throws {ApiException} 项目不存在(not_found) 或非本人(forbidden)
 */
export async function assertProjectOwner(
  admin: SupabaseClient,
  projectId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await admin
    .from('projects')
    .select('owner_id, is_deleted')
    .eq('id', projectId)
    .maybeSingle();
  if (error) {
    throw new ApiException('internal_error', `读取项目失败：${error.message}`);
  }
  if (!data || data.is_deleted) {
    throw new ApiException('not_found', '项目不存在');
  }
  if (data.owner_id !== userId) {
    throw new ApiException('forbidden', '无权访问该项目');
  }
}

export type { SupabaseClient };
