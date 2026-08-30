/**
 * 由模型默认参数与场景构建生成参数的助手（create-project 与 agent-orchestrate 共用）。
 *
 * @module functions/_shared/params
 */

import {
  type GenerationParams,
  type ImageGenerationParams,
  type Modality,
  type ModelDefaultParams,
  type ReferenceMaterial,
  type Scene,
  type VideoGenerationParams,
} from './types.ts';

/** 场景提示词前缀（与前端 lib/scenes 一致）。 */
const SCENE_PREFIX: Record<Scene, string> = {
  design: '通用设计：以简洁现代的视觉风格，',
  branding: '品牌物料：围绕统一的品牌调性（标志、配色、应用示例），',
  ecommerce: '电商物料：以高转化的商品主图视角（干净背景、清晰主体、卖点突出），',
  video: '视频创作：以富有节奏与镜头感的短视频开场，',
};

/**
 * 组合场景提示词前缀与用户输入。
 */
export function composeScenePrompt(scene: Scene | null, userPrompt: string): string {
  if (!scene) return userPrompt;
  return `${SCENE_PREFIX[scene]}${userPrompt}`;
}

/** 场景流程模式默认产出数量。 */
export function sceneGenerationCount(scene: Scene | null): number {
  switch (scene) {
    case 'branding':
    case 'ecommerce':
      return 3;
    default:
      return 1;
  }
}

/**
 * 由模型默认参数与参考素材构建归一化生成参数。
 *
 * @param modality - 模态
 * @param defaultParams - model_catalog.default_params
 * @param references - 参考素材
 * @returns 生成参数
 */
export function buildGenerationParams(
  modality: Modality,
  defaultParams: ModelDefaultParams,
  references: ReferenceMaterial[],
): GenerationParams {
  if (modality === 'video') {
    const params: VideoGenerationParams = {
      modality: 'video',
      durationSec: Number(defaultParams.durationSec ?? 5),
      resolution: String(defaultParams.resolution ?? '720p'),
      aspectRatio: (defaultParams.aspectRatio as VideoGenerationParams['aspectRatio']) ?? '16:9',
      fps: Number(defaultParams.fps ?? 24),
      references,
    };
    return params;
  }
  if (modality === 'text') {
    return {
      modality: 'text',
      maxTokens: Number(defaultParams.maxTokens ?? 512),
      temperature: Number(defaultParams.temperature ?? 0.7),
      references,
    };
  }
  const params: ImageGenerationParams = {
    modality: 'image',
    aspectRatio: (defaultParams.aspectRatio as ImageGenerationParams['aspectRatio']) ?? '1:1',
    width: typeof defaultParams.width === 'number' && defaultParams.width > 0
      ? defaultParams.width
      : undefined,
    height: typeof defaultParams.height === 'number' && defaultParams.height > 0
      ? defaultParams.height
      : undefined,
    sizePreset: defaultParams.sizePreset,
    count: Number(defaultParams.count ?? 1),
    quality: (defaultParams.quality as ImageGenerationParams['quality']) ?? undefined,
    references,
  };
  return params;
}

/** 由模态推导占位 / 产出的默认像素尺寸。 */
export function defaultPlacementSize(
  modality: Modality,
  aspectRatio?: string,
): { width: number; height: number } {
  if (modality === 'video') return { width: 480, height: 270 };
  const ratio = aspectRatio ?? '1:1';
  const [w, h] = ratio.split(':').map((n) => Number(n) || 1);
  const base = 360;
  if (w >= h) return { width: base, height: Math.round((base * h) / w) };
  return { width: Math.round((base * w) / h), height: base };
}
