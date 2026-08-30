import { buildGenerationTelemetry, type TelemetryDimensions } from './telemetry.ts';
import { type GenerationRow } from './types.ts';

/** 构造不含用户内容的最小图片编辑任务。 */
function generation(overrides: Partial<GenerationRow> = {}): GenerationRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    created_at: '2026-08-30T10:00:00.000Z',
    project_id: '00000000-0000-4000-8000-000000000002',
    conversation_id: null,
    message_id: null,
    modality: 'image',
    model_key: 'test-image-editor',
    provider: 'openai',
    prompt: '不得进入遥测的提示词',
    params: {
      modality: 'image',
      operation: 'outpaint',
      inputMode: 'original',
      count: 2,
      references: [{ origin: 'node', nodeId: 'source', assetId: 'asset', role: 'content' }],
      width: 1800,
      height: 1200,
      outputCanvas: {
        width: 1800,
        height: 1200,
        sourceX: 260,
        sourceY: 120,
        sourceWidth: 1280,
        sourceHeight: 960,
      },
    },
    status: 'running',
    progress: 80,
    external_job_id: null,
    result_asset_id: null,
    placeholder_node_id: null,
    target_node_id: 'source',
    result_mode: 'candidate_for_target',
    error: null,
    idempotency_key: 'telemetry-test',
    requester_id: '00000000-0000-4000-8000-000000000003',
    operation_type: 'image:outpaint',
    request_hash: null,
    submission_queue_message_id: null,
    provider_output_summary: null,
    webhook_secret_hash: null,
    webhook_secret_expires_at: null,
    poll_lease_token: null,
    poll_lease_until: null,
    moderation_status: 'approved',
    moderation_reason: null,
    completed_at: null,
    ...overrides,
  };
}

Deno.test('成功遥测记录操作、模型、耗时和媒体尺寸且不泄露用户内容', () => {
  const output: TelemetryDimensions[] = [
    { width: 1800, height: 1200, pixels: 2_160_000 },
    { width: 1800, height: 1200, pixels: 2_160_000 },
  ];
  const record = buildGenerationTelemetry(
    generation(),
    'generation_succeeded',
    { outputDimensions: output, outputCount: 2 },
    new Date('2026-08-30T10:00:03.250Z'),
  );

  if (record.operation !== 'outpaint') throw new Error('操作类型错误');
  if (record.provider !== 'openai' || record.model !== 'test-image-editor') {
    throw new Error('Provider 或模型错误');
  }
  if (record.durationMs !== 3250) throw new Error('耗时错误');
  if (record.inputDimensions?.pixels !== 1_228_800) throw new Error('输入尺寸错误');
  if (record.outputDimensions.length !== 2 || record.outputCount !== 2) {
    throw new Error('输出摘要错误');
  }
  const serialized = JSON.stringify(record);
  if (serialized.includes('不得进入遥测') || serialized.includes('references')) {
    throw new Error('遥测泄露了用户输入');
  }
});

Deno.test('失败与候选采用遥测保留稳定错误码和几何策略', () => {
  const failed = buildGenerationTelemetry(
    generation({ created_at: 'invalid-date' }),
    'generation_failed',
    { errorCode: 'content_blocked' },
    new Date('2026-08-30T10:00:04.000Z'),
  );
  if (failed.errorCode !== 'content_blocked' || failed.durationMs !== null) {
    throw new Error('失败指标错误');
  }

  const adopted = buildGenerationTelemetry(
    generation(),
    'candidate_adopted',
    {
      primaryNodeId: 'primary',
      candidateNodeId: 'candidate',
      geometryMode: 'adopt_output_geometry',
    },
    new Date('2026-08-30T10:00:05.000Z'),
  );
  if (
    adopted.primaryNodeId !== 'primary' ||
    adopted.candidateNodeId !== 'candidate' ||
    adopted.geometryMode !== 'adopt_output_geometry'
  ) {
    throw new Error('候选采用指标错误');
  }
});
