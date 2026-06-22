/**
 * 创作场景定义（第 01 篇、第 05 篇第七节场景流程模式）。
 *
 * 场景按钮为创作预置一套提示词模板与画布初始结构。此处给出场景的展示标签、提示词
 * 前缀与默认模态偏好；画布初始结构的落地（如品牌场景产出一组节点）由 create-project
 * 与 agent-orchestrate 的场景流程模式编排，共享同一套提示词模板。
 *
 * @module lib/scenes
 */

import type { Modality, Scene } from '@/types';

/** 单个场景的定义。 */
export interface SceneDefinition {
  /** 场景键。 */
  scene: Scene;
  /** 展示标签的 i18n 键。 */
  labelKey: string;
  /** 提示词前缀模板，会与用户输入拼接增强。 */
  promptPrefix: string;
  /** 该场景偏好的默认模态。 */
  preferredModality: Modality;
  /** 是否在选择条单独成行展示（Video 居中单行）。 */
  standalone: boolean;
}

/** 场景定义表，驱动主页选择条第二组。 */
export const SCENE_DEFINITIONS: Record<Scene, SceneDefinition> = {
  design: {
    scene: 'design',
    labelKey: 'scene.design',
    promptPrefix: '通用设计：以简洁现代的视觉风格，',
    preferredModality: 'image',
    standalone: false,
  },
  branding: {
    scene: 'branding',
    labelKey: 'scene.branding',
    promptPrefix: '品牌物料：围绕统一的品牌调性（标志、配色、应用示例），',
    preferredModality: 'image',
    standalone: false,
  },
  ecommerce: {
    scene: 'ecommerce',
    labelKey: 'scene.ecommerce',
    promptPrefix: '电商物料：以高转化的商品主图视角（干净背景、清晰主体、卖点突出），',
    preferredModality: 'image',
    standalone: false,
  },
  video: {
    scene: 'video',
    labelKey: 'scene.video',
    promptPrefix: '视频创作：以富有节奏与镜头感的短视频开场，',
    preferredModality: 'video',
    standalone: true,
  },
};

/** 选择条中非单行展示的场景（第一行）。 */
export const INLINE_SCENES: Scene[] = ['design', 'branding', 'ecommerce'];

/** 选择条中单独成行展示的场景。 */
export const STANDALONE_SCENES: Scene[] = ['video'];

/**
 * 组合场景提示词前缀与用户输入。
 *
 * @param scene - 场景（可空，空时直接返回用户输入）
 * @param userPrompt - 用户输入
 * @returns 增强后的提示词
 */
export function composeScenePrompt(scene: Scene | null, userPrompt: string): string {
  if (!scene) return userPrompt;
  const def = SCENE_DEFINITIONS[scene];
  return `${def.promptPrefix}${userPrompt}`;
}
