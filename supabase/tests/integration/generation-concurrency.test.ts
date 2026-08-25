import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const SUBMISSION_ROUNDS = 20;
const LANDING_ROUNDS = 20;
const TEST_PROVIDER = 'custom:neocanvas-concurrency-test';
const TEST_MODEL_KEY = 'neocanvas-concurrency-image';

/** 创建本地 service-role 客户端。 */
function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('缺少本地 Supabase 集成测试环境变量');
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** RPC 出错即携带上下文失败。 */
function assertNoError(error: { message: string } | null, context: string): void {
  if (error) throw new Error(`${context}：${error.message}`);
}

Deno.test('20 轮并发 submission 与 landing 都只提交一次业务结果', async () => {
  const admin = adminClient();
  const email = `neocanvas-concurrency-${crypto.randomUUID()}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  assertNoError(userError, '创建并发测试用户失败');
  const userId = userData.user?.id;
  assertExists(userId);

  let projectId: string | null = null;
  try {
    const { error: credentialError } = await admin.rpc('upsert_provider_credential', {
      p_user_id: userId,
      p_provider: TEST_PROVIDER,
      p_adapter: 'openai',
      p_label: 'Concurrency test only',
      p_website_url: null,
      p_base_url: null,
      p_api_key: 'invalid-test-key-never-used',
      p_enabled: true,
    });
    assertNoError(credentialError, '创建并发测试凭据失败');

    const { error: modelError } = await admin.from('model_catalog').insert({
      key: TEST_MODEL_KEY,
      display_name: 'NeoCanvas concurrency image',
      provider: TEST_PROVIDER,
      modality: 'image',
      capabilities: {
        aspectRatios: ['1:1'],
        sizes: [],
        maxOutputs: 1,
        supportsNegativePrompt: false,
        supportsReferenceImages: false,
        supportsImageToVideo: false,
        supportsSeed: false,
        qualities: [],
        isAsync: false,
        supportsWebhook: false,
      },
      default_params: { providerModel: 'never-called', aspectRatio: '1:1', count: 1 },
      sort_order: -9_000,
      is_active: true,
      user_id: userId,
    });
    assertNoError(modelError, '创建并发测试模型失败');

    const { data: project, error: projectError } = await admin
      .from('projects')
      .insert({ owner_id: userId, title: `Concurrency ${crypto.randomUUID()}` })
      .select('id')
      .single();
    assertNoError(projectError, '创建并发测试项目失败');
    projectId = project?.id ?? null;
    assertExists(projectId);

    // 同一 owner/project/operation/key 并发提交：每轮两个请求只能得到同一 generation。
    for (let round = 0; round < SUBMISSION_ROUNDS; round += 1) {
      const idempotencyKey = `concurrent-submit-${round}-${crypto.randomUUID()}`;
      const requestHash = `hash-${round}-${crypto.randomUUID()}`;
      const call = (generationId: string, placeholderId: string) =>
        admin.rpc('create_generation_submission', {
          p_requester_id: userId,
          p_generation_id: generationId,
          p_project_id: projectId,
          p_conversation_id: null,
          p_message_id: null,
          p_modality: 'image',
          p_model_key: TEST_MODEL_KEY,
          p_prompt: `submission round ${round}`,
          p_params: { modality: 'image', count: 1, references: [] },
          p_idempotency_key: idempotencyKey,
          p_request_hash: requestHash,
          p_placeholder_node_id: placeholderId,
          p_placement: { x: round * 10, y: 0, width: 320, height: 320 },
          p_target_node_id: null,
          p_result_mode: 'new_primary',
          p_operation_type: 'generation',
          p_max_inflight: 100,
        });

      const [left, right] = await Promise.all([
        call(crypto.randomUUID(), crypto.randomUUID()),
        call(crypto.randomUUID(), crypto.randomUUID()),
      ]);
      assertNoError(left.error, `submission 左请求第 ${round + 1} 轮失败`);
      assertNoError(right.error, `submission 右请求第 ${round + 1} 轮失败`);
      assertEquals(left.data.generationId, right.data.generationId);
      assertEquals([left.data.reused, right.data.reused].sort(), [false, true]);

      const { count: generationCount, error: countError } = await admin
        .from('generations')
        .select('id', { count: 'exact', head: true })
        .eq('requester_id', userId)
        .eq('project_id', projectId)
        .eq('operation_type', 'generation')
        .eq('idempotency_key', idempotencyKey);
      assertNoError(countError, '统计并发 submission 结果失败');
      assertEquals(generationCount, 1);

      const { data: submitted } = await admin
        .from('generations')
        .select('submission_queue_message_id')
        .eq('id', left.data.generationId)
        .single();
      if (submitted?.submission_queue_message_id) {
        const { error } = await admin.rpc('delete_generation_job', {
          p_msg_id: submitted.submission_queue_message_id,
        });
        assertNoError(error, '删除并发 submission 测试队列消息失败');
      }
    }

    // 两个独立完成者同时落同一 generation：行锁与终态门禁只允许一组资产进入数据库。
    for (let round = 0; round < LANDING_ROUNDS; round += 1) {
      const generationId = crypto.randomUUID();
      const placeholderId = crypto.randomUUID();
      const { error: generationError } = await admin.from('generations').insert({
        id: generationId,
        project_id: projectId,
        modality: 'image',
        model_key: TEST_MODEL_KEY,
        provider: TEST_PROVIDER,
        prompt: `landing round ${round}`,
        params: { modality: 'image', count: 1, references: [] },
        status: 'running',
        progress: 80,
        requester_id: userId,
        operation_type: 'landing-concurrency',
        request_hash: `landing-${round}`,
        result_mode: 'new_primary',
      });
      assertNoError(generationError, '创建 landing 测试 generation 失败');
      const { error: nodeError } = await admin.from('canvas_nodes').insert({
        id: placeholderId,
        project_id: projectId,
        type: 'generation_placeholder',
        position_x: 0,
        position_y: round * 10,
        width: 320,
        height: 320,
        data: {
          targetModality: 'image',
          promptSummary: `round ${round}`,
          targetWidth: 320,
          targetHeight: 320,
          progress: 80,
          statusLabel: 'running',
        },
        generation_id: generationId,
        created_by: userId,
      });
      assertNoError(nodeError, '创建 landing 占位节点失败');
      const { error: linkageError } = await admin
        .from('generations')
        .update({ placeholder_node_id: placeholderId })
        .eq('id', generationId);
      assertNoError(linkageError, '关联 landing 占位节点失败');

      const attemptIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (const attemptId of attemptIds) {
        const prefix = `staging/${userId}/${generationId}/${attemptId}/`;
        const { error } = await admin.from('generation_output_attempts').insert({
          id: attemptId,
          generation_id: generationId,
          owner_id: userId,
          staging_prefix: prefix,
          storage_bucket: 'generations',
          object_paths: [`${prefix}${attemptId}.png`],
          status: 'staged',
        });
        assertNoError(error, '创建 landing attempt 失败');
      }

      const land = (attemptId: string) => {
        const assetId = crypto.randomUUID();
        const path = `staging/${userId}/${generationId}/${attemptId}/${attemptId}.png`;
        return admin.rpc('land_generation_result_once', {
          p_generation_id: generationId,
          p_owner_id: userId,
          p_project_id: projectId,
          p_placeholder_node_id: placeholderId,
          p_attempt_id: attemptId,
          p_assets: [
            {
              id: assetId,
              kind: 'image',
              mimeType: 'image/png',
              storageBucket: 'generations',
              storagePath: path,
              thumbnailPath: null,
              width: 1,
              height: 1,
              durationMs: null,
              sizeBytes: 68,
            },
          ],
          p_first_node: {
            type: 'image',
            assetId,
            data: { assetId, naturalWidth: 1, naturalHeight: 1 },
          },
          p_extra_nodes: [],
          p_result_asset_id: assetId,
          p_provider_output_summary: { round, attemptId },
        });
      };

      const [left, right] = await Promise.all([land(attemptIds[0]), land(attemptIds[1])]);
      assertNoError(left.error, `landing 左请求第 ${round + 1} 轮失败`);
      assertNoError(right.error, `landing 右请求第 ${round + 1} 轮失败`);
      assertEquals([left.data.landed, right.data.landed].sort(), [false, true]);

      const { count: assetCount, error: assetCountError } = await admin
        .from('assets')
        .select('id', { count: 'exact', head: true })
        .eq('generation_id', generationId);
      assertNoError(assetCountError, '统计并发 landing 资产失败');
      assertEquals(assetCount, 1);
      const { data: attempts, error: attemptsError } = await admin
        .from('generation_output_attempts')
        .select('status')
        .eq('generation_id', generationId);
      assertNoError(attemptsError, '读取并发 landing 尝试失败');
      assertEquals((attempts ?? []).map((attempt) => attempt.status).sort(), [
        'committed',
        'discarded',
      ]);
    }
  } finally {
    if (projectId) await admin.from('projects').delete().eq('id', projectId);
    await admin.from('model_catalog').delete().eq('key', TEST_MODEL_KEY).eq('user_id', userId);
    const { data: credentials } = await admin
      .from('provider_credentials')
      .select('id')
      .eq('user_id', userId);
    for (const credential of credentials ?? []) {
      await admin.rpc('delete_provider_credential', { p_user_id: userId, p_id: credential.id });
    }
    await admin.auth.admin.deleteUser(userId);
  }
});
