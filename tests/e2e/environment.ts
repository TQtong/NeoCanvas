import { execFileSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** E2E 专用且不接收真实邮件的固定本地账号。 */
export const E2E_EMAIL = 'neocanvas-e2e@example.test';
/** E2E 模型键；不会进入生产 seed。 */
export const E2E_MODEL_KEY = 'neocanvas-e2e-image';
/** E2E Provider；与 Edge 侧测试守卫逐字一致。 */
export const E2E_PROVIDER = 'custom:neocanvas-test';

/** Supabase CLI 本地状态中测试所需的最小字段。 */
interface LocalSupabaseStatus {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
}

/** 读取本地 Supabase 状态，且不把密钥写入日志或测试工件。 */
export function localSupabaseStatus(): LocalSupabaseStatus {
  const raw = execFileSync(
    process.execPath,
    ['node_modules/supabase/dist/supabase.js', 'status', '--output', 'json'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const parsed = JSON.parse(raw) as Partial<LocalSupabaseStatus>;
  if (!parsed.API_URL || !parsed.SERVICE_ROLE_KEY) {
    throw new Error('本地 Supabase 未启动或状态中缺少服务角色配置');
  }
  return parsed as LocalSupabaseStatus;
}

/** 创建只在 Node 测试进程中存在的 service-role 客户端。 */
export function createLocalAdmin(): SupabaseClient {
  const status = localSupabaseStatus();
  return createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 按邮箱查找测试用户；测试环境用户量有限，仍显式分页避免默认页截断。 */
export async function findE2eUser(admin: SupabaseClient) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email === E2E_EMAIL);
    if (user) return user;
    if (data.users.length < 100) return null;
  }
  throw new Error('本地 Auth 用户数量异常，无法在限定分页内查找 E2E 用户');
}

/** 递归列出一个 Storage 前缀中的实际对象路径。 */
async function listStorageObjects(
  admin: SupabaseClient,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const paths: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    for (const entry of data ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) paths.push(path);
      else paths.push(...(await listStorageObjects(admin, bucket, path)));
    }
    if (!data || data.length < 100) break;
    offset += data.length;
  }
  return paths;
}

/** 清理该专用测试用户上轮遗留的业务行与生成对象，不触碰其他 namespace。 */
export async function cleanupE2eNamespace(admin: SupabaseClient, userId: string): Promise<void> {
  const objects = await listStorageObjects(admin, 'generations', `staging/${userId}`);
  for (let start = 0; start < objects.length; start += 100) {
    const { error } = await admin.storage
      .from('generations')
      .remove(objects.slice(start, start + 100));
    if (error) throw error;
  }

  const { error: projectsError } = await admin.from('projects').delete().eq('owner_id', userId);
  if (projectsError) throw projectsError;
  const { error: assetsError } = await admin.from('assets').delete().eq('owner_id', userId);
  if (assetsError) throw assetsError;
}
