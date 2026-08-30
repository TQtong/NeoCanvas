/**
 * 生成链路结构化遥测。
 *
 * 事件只包含可聚合的运行指标，不记录提示词、签名 URL、用户输入或 Provider 原始响应。
 * `generation_succeeded` 与 `candidate_adopted` 的事件数量可用于计算候选采用率。
 *
 * @module functions/_shared/telemetry
 */

import { type ErrorCode, type GenerationRow, normalizeImageOperation } from './types.ts';

/** 可观测的生成生命周期事件。 */
export type GenerationTelemetryEvent =
  | 'generation_succeeded'
  | 'generation_failed'
  | 'candidate_adopted';

/** 不含资源地址的媒体尺寸摘要。 */
export interface TelemetryDimensions {
  width: number;
  height: number;
  pixels: number;
}

/** 单个生成事件允许附加的受控指标。 */
export interface GenerationTelemetryDetails {
  errorCode?: ErrorCode;
  outputDimensions?: TelemetryDimensions[];
  outputCount?: number;
  primaryNodeId?: string;
  candidateNodeId?: string;
  geometryMode?: 'preserve_frame' | 'adopt_output_geometry';
}

/** 日志中稳定输出的结构化记录。 */
export interface GenerationTelemetryRecord {
  schema: 'neocanvas.generation.v1';
  event: GenerationTelemetryEvent;
  occurredAt: string;
  generationId: string;
  projectId: string;
  operation: string;
  provider: string;
  model: string;
  resultMode: string;
  durationMs: number | null;
  inputDimensions: TelemetryDimensions | null;
  outputDimensions: TelemetryDimensions[];
  outputCount: number;
  errorCode: ErrorCode | null;
  primaryNodeId: string | null;
  candidateNodeId: string | null;
  geometryMode: 'preserve_frame' | 'adopt_output_geometry' | null;
}

/** 把宽高转换成有限正整数，防止损坏的参数污染指标。 */
function dimensions(width: unknown, height: unknown): TelemetryDimensions | null {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const safeWidth = Math.round(width);
  const safeHeight = Math.round(height);
  return {
    width: safeWidth,
    height: safeHeight,
    pixels: safeWidth * safeHeight,
  };
}

/** 从判别联合中提取最接近真实源图的输入尺寸。 */
function inputDimensions(generation: GenerationRow): TelemetryDimensions | null {
  if (generation.params.modality !== 'image') return null;

  const operation = normalizeImageOperation(generation.params);
  if (operation === 'outpaint' && generation.params.operation === 'outpaint') {
    return dimensions(
      generation.params.outputCanvas.sourceWidth,
      generation.params.outputCanvas.sourceHeight,
    );
  }
  if (operation === 'upscale' && generation.params.operation === 'upscale') {
    const output = dimensions(generation.params.width, generation.params.height);
    return output
      ? dimensions(
        output.width / generation.params.upscaleFactor,
        output.height / generation.params.upscaleFactor,
      )
      : null;
  }
  return dimensions(generation.params.width, generation.params.height);
}

/** 按任务创建时间计算端到端耗时；非法时间不制造虚假数据。 */
function durationMs(generation: GenerationRow, occurredAt: Date): number | null {
  const startedAt = Date.parse(generation.created_at);
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, occurredAt.getTime() - startedAt);
}

/**
 * 构造稳定的遥测载荷。显式接收时间便于单元测试和不同推进路径复用。
 */
export function buildGenerationTelemetry(
  generation: GenerationRow,
  event: GenerationTelemetryEvent,
  details: GenerationTelemetryDetails = {},
  occurredAt = new Date(),
): GenerationTelemetryRecord {
  const operation = generation.params.modality === 'image'
    ? normalizeImageOperation(generation.params)
    : generation.operation_type;
  const outputDimensions = details.outputDimensions ?? [];
  return {
    schema: 'neocanvas.generation.v1',
    event,
    occurredAt: occurredAt.toISOString(),
    generationId: generation.id,
    projectId: generation.project_id,
    operation,
    provider: generation.provider,
    model: generation.model_key,
    resultMode: generation.result_mode,
    durationMs: durationMs(generation, occurredAt),
    inputDimensions: inputDimensions(generation),
    outputDimensions,
    outputCount: details.outputCount ?? outputDimensions.length,
    errorCode: details.errorCode ?? null,
    primaryNodeId: details.primaryNodeId ?? null,
    candidateNodeId: details.candidateNodeId ?? null,
    geometryMode: details.geometryMode ?? null,
  };
}

/** 输出单行 JSON，便于 Supabase Logs Explorer 与外部日志平台聚合。 */
export function logGenerationTelemetry(
  generation: GenerationRow,
  event: GenerationTelemetryEvent,
  details: GenerationTelemetryDetails = {},
): void {
  console.info(JSON.stringify(buildGenerationTelemetry(generation, event, details)));
}
