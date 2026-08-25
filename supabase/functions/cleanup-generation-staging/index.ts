/**
 * 清理过期生成暂存对象。
 *
 * 只消费数据库认领的 `staging/` 尝试与精确对象路径；删除前再次排除已被 assets 引用的
 * 路径，因此即便 landing 响应丢失、账本状态更新竞争，也不会误删已提交业务资产。
 *
 * @module functions/cleanup-generation-staging
 */

import { requireInternalServiceRole } from '../_shared/internal-auth.ts';
import { exceptionToResponse, fail, ok } from '../_shared/response.ts';
import { createAdminClient } from '../_shared/supabase.ts';

/** 单次补偿批量，控制 Edge 执行时间与 Storage API 压力。 */
const BATCH = 50;

interface StagingAttemptRow {
  id: string;
  storage_bucket: string;
  staging_prefix: string;
  object_paths: unknown;
}

/** 从 JSONB 账本中只接受属于当前 staging 前缀的字符串路径。 */
function safePaths(attempt: StagingAttemptRow): string[] {
  if (!Array.isArray(attempt.object_paths)) return [];
  return Array.from(
    new Set(
      attempt.object_paths.filter(
        (path): path is string =>
          typeof path === 'string' &&
          attempt.staging_prefix.startsWith('staging/') &&
          path.startsWith(attempt.staging_prefix),
      ),
    ),
  );
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return fail('invalid_params', '仅支持 POST');
  try {
    requireInternalServiceRole(request);
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('claim_stale_generation_output_attempts', {
      p_qty: BATCH,
    });
    if (error) throw error;

    const attempts = (data ?? []) as StagingAttemptRow[];
    let cleaned = 0;
    let protectedObjects = 0;
    let failed = 0;

    for (const attempt of attempts) {
      const paths = safePaths(attempt);
      const { data: referenced, error: referenceError } = paths.length === 0
        ? { data: [], error: null }
        : await admin
          .from('assets')
          .select('storage_path')
          .eq('storage_bucket', attempt.storage_bucket)
          .in('storage_path', paths);
      if (referenceError) {
        failed += 1;
        continue;
      }

      const protectedSet = new Set((referenced ?? []).map((row) => row.storage_path as string));
      const removable = paths.filter((path) => !protectedSet.has(path));
      protectedObjects += protectedSet.size;
      if (removable.length > 0) {
        const { error: removeError } = await admin.storage
          .from(attempt.storage_bucket)
          .remove(removable);
        if (removeError) {
          await admin
            .from('generation_output_attempts')
            .update({ status: 'discarded', error: removeError.message })
            .eq('id', attempt.id)
            .neq('status', 'committed');
          failed += 1;
          continue;
        }
      }

      // 发现正式引用说明 landing 已提交；其余情况本尝试已经完成补偿。
      const status = protectedSet.size > 0 ? 'committed' : 'cleaned';
      await admin
        .from('generation_output_attempts')
        .update({ status, error: null })
        .eq('id', attempt.id)
        .neq('status', 'committed');
      cleaned += 1;
    }

    return ok({ claimed: attempts.length, cleaned, protectedObjects, failed });
  } catch (error) {
    return exceptionToResponse(error);
  }
});
