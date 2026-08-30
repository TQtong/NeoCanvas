import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const SUBMISSION_ROUNDS = 20;
const LANDING_ROUNDS = 20;
const ADOPTION_ROUNDS = 20;
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
        imageOperations: ['generate', 'semantic_edit'],
        aspectRatios: ['1:1'],
        sizes: [],
        maxOutputs: 1,
        supportsNegativePrompt: false,
        supportsReferenceImages: true,
        supportsImageToVideo: false,
        supportsSeed: false,
        qualities: [],
        isAsync: false,
        supportsWebhook: false,
        maxInputImages: 1,
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

    const sourceAssetId = crypto.randomUUID();
    const { error: sourceAssetError } = await admin.from('assets').insert({
      id: sourceAssetId,
      owner_id: userId,
      project_id: projectId,
      kind: 'image',
      source: 'upload',
      storage_bucket: 'uploads',
      storage_path: `${userId}/${projectId}/concurrency-source.png`,
      mime_type: 'image/png',
      width: 1,
      height: 1,
      size_bytes: 68,
    });
    assertNoError(sourceAssetError, '创建并发输入源资产失败');

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
          p_params: {
            modality: 'image',
            operation: 'semantic_edit',
            inputMode: 'original',
            count: 1,
            references: [{ origin: 'attachment', assetId: sourceAssetId, role: 'content' }],
          },
          p_idempotency_key: idempotencyKey,
          p_request_hash: requestHash,
          p_placeholder_node_id: placeholderId,
          p_placement: { x: round * 10, y: 0, width: 320, height: 320 },
          p_inputs: [{ assetId: sourceAssetId, role: 'content' }],
          p_target_node_id: null,
          p_result_mode: 'new_primary',
          p_operation_type: 'image:semantic_edit',
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
        .eq('operation_type', 'image:semantic_edit')
        .eq('idempotency_key', idempotencyKey);
      assertNoError(countError, '统计并发 submission 结果失败');
      assertEquals(generationCount, 1);
      const { count: inputCount, error: inputCountError } = await admin
        .from('generation_inputs')
        .select('generation_id', { count: 'exact', head: true })
        .eq('generation_id', left.data.generationId);
      assertNoError(inputCountError, '统计并发 generation_inputs 失败');
      assertEquals(inputCount, 1);
      const { count: placeholderCount, error: placeholderCountError } = await admin
        .from('canvas_nodes')
        .select('id', { count: 'exact', head: true })
        .eq('generation_id', left.data.generationId)
        .eq('type', 'generation_placeholder');
      assertNoError(placeholderCountError, '统计并发首占位失败');
      assertEquals(placeholderCount, 1);

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

    // 同一候选的重叠采用必须由事务 advisory lock 立即拒绝一方，不能串行交换两次回到原状。
    for (let round = 0; round < ADOPTION_ROUNDS; round += 1) {
      const primaryAssetId = crypto.randomUUID();
      const candidateAssetId = crypto.randomUUID();
      const generationId = crypto.randomUUID();
      const primaryNodeId = crypto.randomUUID();
      const candidateNodeId = crypto.randomUUID();
      const { error: assetError } = await admin.from('assets').insert([
        {
          id: primaryAssetId,
          owner_id: userId,
          project_id: projectId,
          kind: 'image',
          source: 'upload',
          storage_bucket: 'uploads',
          storage_path: `${userId}/${projectId}/adoption-${round}-primary.png`,
          mime_type: 'image/png',
          width: 320,
          height: 200,
          size_bytes: 68,
        },
        {
          id: candidateAssetId,
          owner_id: userId,
          project_id: projectId,
          kind: 'image',
          source: 'generation',
          storage_bucket: 'generations',
          storage_path: `staging/${userId}/${generationId}/candidate.png`,
          mime_type: 'image/png',
          width: 320,
          height: 200,
          size_bytes: 68,
        },
      ]);
      assertNoError(assetError, '创建候选采用并发资产失败');
      const { error: editGenerationError } = await admin.from('generations').insert({
        id: generationId,
        project_id: projectId,
        modality: 'image',
        model_key: TEST_MODEL_KEY,
        provider: TEST_PROVIDER,
        prompt: `adoption round ${round}`,
        params: {
          modality: 'image',
          operation: 'semantic_edit',
          inputMode: 'original',
          count: 1,
          references: [],
        },
        status: 'succeeded',
        requester_id: userId,
        operation_type: 'image:semantic_edit',
        result_mode: 'candidate_for_target',
      });
      assertNoError(editGenerationError, '创建候选采用 generation 失败');
      const { error: adoptionNodesError } = await admin.from('canvas_nodes').insert([
        {
          id: primaryNodeId,
          project_id: projectId,
          type: 'image',
          position_x: 0,
          position_y: round * 220,
          width: 320,
          height: 200,
          data: { assetId: primaryAssetId, mediaRole: 'primary' },
          asset_id: primaryAssetId,
          created_by: userId,
        },
        {
          id: candidateNodeId,
          project_id: projectId,
          type: 'image',
          position_x: 700,
          position_y: round * 220,
          width: 320,
          height: 200,
          data: {
            assetId: candidateAssetId,
            mediaRole: 'candidate',
            candidateOf: primaryNodeId,
            candidateIndex: 0,
            sourceOperation: 'semantic_edit',
          },
          asset_id: candidateAssetId,
          generation_id: generationId,
          created_by: userId,
        },
      ]);
      assertNoError(adoptionNodesError, '创建候选采用并发节点失败');
      const { error: adoptionEdgeError } = await admin.from('canvas_edges').insert({
        project_id: projectId,
        source_node_id: primaryNodeId,
        target_node_id: candidateNodeId,
        source_handle: 'media-candidate-out',
        target_handle: 'media-candidate-in',
        type: 'media_candidate',
        data: { label: '候选' },
      });
      assertNoError(adoptionEdgeError, '创建候选采用并发边失败');

      const adopt = () =>
        admin.rpc('swap_media_candidate', {
          p_project_id: projectId,
          p_primary_node_id: primaryNodeId,
          p_candidate_node_id: candidateNodeId,
          p_geometry_mode: 'preserve_frame',
        });
      const attempts = await Promise.all([adopt(), adopt()]);
      assertEquals(attempts.filter((attempt) => !attempt.error && attempt.data === true).length, 1);
      assertEquals(
        attempts.filter((attempt) => attempt.error?.message.includes('CANDIDATE_ADOPTION_CONFLICT'))
          .length,
        1,
      );
      const { data: primaryAfter, error: primaryAfterError } = await admin
        .from('canvas_nodes')
        .select('asset_id')
        .eq('id', primaryNodeId)
        .single();
      assertNoError(primaryAfterError, '读取并发采用后的主节点失败');
      assertEquals(primaryAfter?.asset_id, candidateAssetId);
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
