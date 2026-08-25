import type { FullConfig } from '@playwright/test';
import { E2E_MODEL_KEY, cleanupE2eNamespace, createLocalAdmin, findE2eUser } from './environment';

/** 精确删除 E2E namespace、Vault 凭据与测试 Auth 用户。 */
export default async function globalTeardown(_config: FullConfig): Promise<void> {
  // 本地排障可显式保留专用 namespace；默认与 CI 始终执行完整清理。
  if (process.env.E2E_KEEP_DATA === 'true' && !process.env.CI) return;
  const admin = createLocalAdmin();
  const user = await findE2eUser(admin);
  if (!user) return;

  await cleanupE2eNamespace(admin, user.id);
  const { error: modelError } = await admin
    .from('model_catalog')
    .delete()
    .eq('key', E2E_MODEL_KEY)
    .eq('user_id', user.id);
  if (modelError) throw modelError;

  const { data: credentials, error: credentialsError } = await admin
    .from('provider_credentials')
    .select('id')
    .eq('user_id', user.id);
  if (credentialsError) throw credentialsError;
  for (const credential of credentials ?? []) {
    const { error } = await admin.rpc('delete_provider_credential', {
      p_user_id: user.id,
      p_id: credential.id,
    });
    if (error) throw error;
  }

  const { error: userError } = await admin.auth.admin.deleteUser(user.id);
  if (userError) throw userError;
}
