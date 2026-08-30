/**
 * Flow Studio 节点注册表。
 *
 * UI、图校验、Flow App 字段暴露与执行计划共同依赖这份静态定义。新增节点必须同时声明
 * 强类型端口、配置 Schema、执行器版本和缓存策略，禁止只在某一层硬编码。
 *
 * @module lib/workflow/registry
 */

import { z } from 'zod';
import type {
  FlowValueType,
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowNodeConfig,
  WorkflowNodeKind,
  WorkflowPortDefinition,
  WorkflowValidationProblem,
} from '@/types';
import { validateWorkflowGraphStructure } from '@/types';

/** 节点所属目录。 */
export type WorkflowNodeCategory = 'input' | 'transform' | 'image' | 'video' | 'output' | 'utility';

/** 节点运行时注册定义。 */
export interface WorkflowNodeDefinition {
  kind: WorkflowNodeKind;
  title: string;
  description: string;
  category: WorkflowNodeCategory;
  schemaVersion: number;
  executorVersion: string;
  inputs: WorkflowPortDefinition[];
  outputs: WorkflowPortDefinition[];
  configSchema: z.ZodType<WorkflowNodeConfig>;
  defaultConfig: WorkflowNodeConfig;
  appExposablePaths: string[];
  cachePolicy: 'never' | 'content';
  requiredCapability?: string;
}

const port = (
  id: string,
  label: string,
  valueType: FlowValueType,
  options: Partial<Pick<WorkflowPortDefinition, 'required' | 'multiple'>> = {},
): WorkflowPortDefinition => ({
  id,
  label,
  valueType,
  required: options.required ?? false,
  multiple: options.multiple ?? false,
});

const labelSchema = z.object({ label: z.string().trim().max(80).optional() });
const assetSchema = labelSchema.extend({ assetId: z.string().uuid().nullable() });
const imageGenerateSchema = labelSchema.extend({
  modelKey: z.string().min(1).nullable(),
  count: z.number().int().min(1).max(8),
  aspectRatio: z.string().min(1),
  width: z.number().int().min(64).max(8192).optional(),
  height: z.number().int().min(64).max(8192).optional(),
  quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
});
const imageEditSchema = imageGenerateSchema.extend({
  inputMode: z.enum(['original', 'flattened']),
  inputFidelity: z.enum(['standard', 'high']).optional(),
});
const videoGenerateSchema = labelSchema.extend({
  modelKey: z.string().min(1).nullable(),
  durationSec: z.number().int().min(1).max(60),
  resolution: z.string().min(1),
  aspectRatio: z.string().min(1),
  fps: z.number().int().min(1).max(60),
  motionStrength: z.number().min(0).max(1).optional(),
});

const imageSettings = {
  modelKey: null,
  count: 1,
  aspectRatio: '1:1',
  quality: 'auto' as const,
};
const imageEditSettings = { ...imageSettings, inputMode: 'original' as const };
const videoSettings = {
  modelKey: null,
  durationSec: 5,
  resolution: '720p',
  aspectRatio: '16:9',
  fps: 24,
};

/** 完整节点目录；顺序也是左侧节点库默认顺序。 */
export const WORKFLOW_NODE_DEFINITIONS: readonly WorkflowNodeDefinition[] = [
  {
    kind: 'text_input',
    title: '文本输入',
    description: '输入提示词、主题或其他文字参数',
    category: 'input',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [],
    outputs: [port('text', '文本', 'text', { required: true })],
    configSchema: labelSchema.extend({ value: z.string().max(20_000) }),
    defaultConfig: { value: '' },
    appExposablePaths: ['value'],
    cachePolicy: 'content',
  },
  {
    kind: 'image_input',
    title: '图片输入',
    description: '引用项目中的一张图片资产',
    category: 'input',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [],
    outputs: [port('image', '图片', 'image_asset', { required: true })],
    configSchema: assetSchema,
    defaultConfig: { assetId: null },
    appExposablePaths: ['assetId'],
    cachePolicy: 'content',
  },
  {
    kind: 'video_input',
    title: '视频输入',
    description: '引用项目中的一段视频资产',
    category: 'input',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [],
    outputs: [port('video', '视频', 'video_asset', { required: true })],
    configSchema: assetSchema,
    defaultConfig: { assetId: null },
    appExposablePaths: ['assetId'],
    cachePolicy: 'content',
  },
  {
    kind: 'mask_input',
    title: '蒙版输入',
    description: '引用局部重绘使用的蒙版资产',
    category: 'input',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [],
    outputs: [port('mask', '蒙版', 'mask_asset', { required: true })],
    configSchema: assetSchema,
    defaultConfig: { assetId: null },
    appExposablePaths: ['assetId'],
    cachePolicy: 'content',
  },
  {
    kind: 'prompt_template',
    title: 'Prompt 模板',
    description: '用 {{变量}} 组合可复用提示词',
    category: 'transform',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('variables', '变量', 'text', { multiple: true })],
    outputs: [port('text', 'Prompt', 'text', { required: true })],
    configSchema: labelSchema.extend({ template: z.string().max(20_000) }),
    defaultConfig: { template: '{{variables}}' },
    appExposablePaths: ['template'],
    cachePolicy: 'content',
  },
  {
    kind: 'image_collection',
    title: '图片集合',
    description: '合并固定图片与上游图片',
    category: 'transform',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('images', '图片', 'image_asset', { multiple: true })],
    outputs: [port('images', '图片集合', 'image_list', { required: true })],
    configSchema: labelSchema.extend({ assetIds: z.array(z.string().uuid()).max(100) }),
    defaultConfig: { assetIds: [] },
    appExposablePaths: ['assetIds'],
    cachePolicy: 'content',
  },
  {
    kind: 'keyframe_collection',
    title: '关键帧集合',
    description: '按连接顺序组织视频关键帧',
    category: 'transform',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('images', '关键帧', 'image_asset', { multiple: true })],
    outputs: [port('keyframes', '关键帧集合', 'keyframe_list', { required: true })],
    configSchema: labelSchema.extend({ assetIds: z.array(z.string().uuid()).max(100) }),
    defaultConfig: { assetIds: [] },
    appExposablePaths: ['assetIds'],
    cachePolicy: 'content',
  },
  {
    kind: 'image_select',
    title: '图片选择',
    description: '固定选择或在运行时人工挑选',
    category: 'transform',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('images', '候选图片', 'image_list', { required: true })],
    outputs: [port('image', '已选图片', 'image_asset', { required: true })],
    configSchema: labelSchema.extend({
      mode: z.enum(['manual', 'fixed']),
      selectedIndex: z.number().int().min(0),
    }),
    defaultConfig: { mode: 'manual', selectedIndex: 0 },
    appExposablePaths: ['mode', 'selectedIndex'],
    cachePolicy: 'never',
  },
  {
    kind: 'image_generate',
    title: '图片生成',
    description: '通过精确绑定的模型生成图片',
    category: 'image',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('prompt', 'Prompt', 'text', { required: true })],
    outputs: [port('images', '生成图片', 'image_list', { required: true })],
    configSchema: imageGenerateSchema,
    defaultConfig: imageSettings,
    appExposablePaths: ['count', 'aspectRatio', 'width', 'height', 'quality'],
    cachePolicy: 'content',
    requiredCapability: 'image:generate',
  },
  ...([['image_semantic_edit', '语义编辑', 'image:semantic_edit']] as const).map(
    ([kind, title, capability]) => ({
      kind,
      title,
      description: `使用精确绑定模型执行${title}`,
      category: 'image' as const,
      schemaVersion: 1,
      executorVersion: '1',
      inputs: [
        port('image', '原图', 'image_asset', { required: true }),
        port('prompt', 'Prompt', 'text'),
      ],
      outputs: [port('images', '编辑结果', 'image_list', { required: true })],
      configSchema: imageEditSchema,
      defaultConfig: imageEditSettings,
      appExposablePaths: ['count', 'aspectRatio', 'quality', 'inputFidelity'],
      cachePolicy: 'content' as const,
      requiredCapability: capability,
    }),
  ),
  {
    kind: 'image_remove_background',
    title: '移除背景',
    description: '移除背景并输出单张透明图片',
    category: 'image',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('image', '原图', 'image_asset', { required: true })],
    outputs: [port('image', '透明图片', 'image_asset', { required: true })],
    configSchema: imageEditSchema,
    defaultConfig: imageEditSettings,
    appExposablePaths: ['quality', 'inputFidelity'],
    cachePolicy: 'content',
    requiredCapability: 'image:remove_background',
  },
  {
    kind: 'image_inpaint',
    title: '局部重绘',
    description: '使用原图、蒙版与 Prompt 重绘局部区域',
    category: 'image',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [
      port('image', '原图', 'image_asset', { required: true }),
      port('mask', '蒙版', 'mask_asset', { required: true }),
      port('prompt', 'Prompt', 'text', { required: true }),
    ],
    outputs: [port('images', '重绘结果', 'image_list', { required: true })],
    configSchema: imageEditSchema.extend({ maskFeatherPx: z.number().int().min(0).max(256) }),
    defaultConfig: { ...imageEditSettings, maskFeatherPx: 8 },
    appExposablePaths: ['count', 'quality', 'maskFeatherPx'],
    cachePolicy: 'content',
    requiredCapability: 'image:inpaint',
  },
  {
    kind: 'image_outpaint',
    title: '扩图',
    description: '扩展图片画布并生成边缘内容',
    category: 'image',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [
      port('image', '原图', 'image_asset', { required: true }),
      port('prompt', 'Prompt', 'text'),
    ],
    outputs: [port('images', '扩图结果', 'image_list', { required: true })],
    configSchema: imageEditSchema.extend({
      outputWidth: z.number().int().min(64).max(8192),
      outputHeight: z.number().int().min(64).max(8192),
      sourceX: z.number().int().min(0),
      sourceY: z.number().int().min(0),
    }),
    defaultConfig: {
      ...imageEditSettings,
      outputWidth: 1536,
      outputHeight: 1536,
      sourceX: 256,
      sourceY: 256,
    },
    appExposablePaths: ['outputWidth', 'outputHeight', 'sourceX', 'sourceY', 'quality'],
    cachePolicy: 'content',
    requiredCapability: 'image:outpaint',
  },
  {
    kind: 'image_upscale',
    title: '图片放大',
    description: '将图片放大 2 倍或 4 倍',
    category: 'image',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port('image', '原图', 'image_asset', { required: true })],
    outputs: [port('image', '放大结果', 'image_asset', { required: true })],
    configSchema: imageEditSchema.extend({ factor: z.union([z.literal(2), z.literal(4)]) }),
    defaultConfig: { ...imageEditSettings, factor: 2 },
    appExposablePaths: ['factor'],
    cachePolicy: 'content',
    requiredCapability: 'image:upscale',
  },
  {
    kind: 'video_generate',
    title: '视频生成',
    description: '从 Prompt 或首帧生成视频',
    category: 'video',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [
      port('prompt', 'Prompt', 'text', { required: true }),
      port('first_frame', '首帧', 'image_asset'),
    ],
    outputs: [port('video', '生成视频', 'video_asset', { required: true })],
    configSchema: videoGenerateSchema,
    defaultConfig: videoSettings,
    appExposablePaths: ['durationSec', 'resolution', 'aspectRatio', 'fps', 'motionStrength'],
    cachePolicy: 'content',
    requiredCapability: 'video:generate',
  },
  {
    kind: 'sequence_video',
    title: '序列视频',
    description: '按关键帧顺序生成并拼接视频',
    category: 'video',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [
      port('prompt', 'Prompt', 'text'),
      port('keyframes', '关键帧', 'keyframe_list', { required: true }),
    ],
    outputs: [port('video', '序列视频', 'video_asset', { required: true })],
    configSchema: videoGenerateSchema,
    defaultConfig: videoSettings,
    appExposablePaths: ['durationSec', 'resolution', 'fps', 'motionStrength'],
    cachePolicy: 'content',
    requiredCapability: 'video:keyframes',
  },
  ...(
    [
      ['text_output', '文本输出', 'text', 'text'],
      ['image_output', '图片输出', 'image_asset', 'image'],
      ['video_output', '视频输出', 'video_asset', 'video'],
      ['gallery_output', '图库输出', 'image_list', 'images'],
    ] as const
  ).map(([kind, title, valueType, portId]) => ({
    kind,
    title,
    description: `声明工作流的${title}`,
    category: 'output' as const,
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [port(portId, title, valueType, { required: true })],
    outputs: [port(portId, title, valueType, { required: true })],
    configSchema: labelSchema,
    defaultConfig: {},
    appExposablePaths: [],
    cachePolicy: 'content' as const,
  })),
  {
    kind: 'note',
    title: '注释',
    description: '记录工作流说明，不参与执行',
    category: 'utility',
    schemaVersion: 1,
    executorVersion: '1',
    inputs: [],
    outputs: [],
    configSchema: labelSchema.extend({ text: z.string().max(10_000) }),
    defaultConfig: { text: '' },
    appExposablePaths: [],
    cachePolicy: 'never',
  },
];

/** 按 kind 索引的节点注册表。 */
export const WORKFLOW_NODE_REGISTRY = new Map(
  WORKFLOW_NODE_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

/** 获取节点定义；未知 kind 为契约漂移，直接抛错。 */
export function getWorkflowNodeDefinition(kind: WorkflowNodeKind): WorkflowNodeDefinition {
  const definition = WORKFLOW_NODE_REGISTRY.get(kind);
  if (!definition) throw new Error(`未知工作流节点：${kind}`);
  return definition;
}

/** 创建带默认配置的新节点。 */
export function createWorkflowGraphNode(
  kind: WorkflowNodeKind,
  position: { x: number; y: number },
): WorkflowGraphNode {
  const definition = getWorkflowNodeDefinition(kind);
  return {
    id: crypto.randomUUID(),
    kind,
    position,
    config: structuredClone(definition.defaultConfig),
    schemaVersion: definition.schemaVersion,
  };
}

/** 在结构校验基础上追加配置 Schema 校验。 */
export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowValidationProblem[] {
  const problems = validateWorkflowGraphStructure(graph, WORKFLOW_NODE_DEFINITIONS);
  for (const node of graph.nodes) {
    const result = getWorkflowNodeDefinition(node.kind).configSchema.safeParse(node.config);
    if (!result.success) {
      problems.push({
        code: 'invalid_config',
        nodeId: node.id,
        message: result.error.issues.map((issue) => issue.message).join('；'),
      });
    }
  }
  return problems;
}

/** 判断配置路径能否由 Flow App 暴露。 */
export function isFlowAppPathAllowed(kind: WorkflowNodeKind, path: string): boolean {
  return getWorkflowNodeDefinition(kind).appExposablePaths.includes(path);
}
