/**
 * 编排规划（第 05 篇第七节）。
 *
 * 把一次用户意图翻译为「编排计划」：一段助手回复 + 一到多个生成步骤。每个步骤声明模态、
 * 数量、精炼后的提示词，以及如何使用参考素材（角色与是否启用）。多步骤支持真正的序列
 * 编排（例如先出 N 张图、再据其出一段视频）。
 *
 * 计划由编排型 LLM 产出（结构化 JSON）；仅在未配置 LLM 时退化为确定性规划，作为可用性
 * 兜底而非主路径。
 *
 * @module functions/_shared/orchestrate-plan
 */

import { type AgentMode, type Modality, type Scene } from './types.ts';
import { getLlmAdapter, isLlmConfigured, type LlmMessage } from './adapters/text.ts';
import { composeScenePrompt, sceneGenerationCount } from './params.ts';

/** 单个生成步骤。 */
export interface OrchestrationStep {
  /** 该步产出模态。 */
  modality: 'image' | 'video';
  /** 该步产出数量（执行时再按所选模型上限钳制）。 */
  count: number;
  /** 该步精炼后的提示词。 */
  prompt: string;
  /** 参考素材在该步中的角色。 */
  referenceRole: 'content' | 'style' | 'first_frame';
  /** 是否在该步使用参考素材。 */
  useReferences: boolean;
}

/** 编排计划。 */
export interface OrchestrationPlan {
  /** 流式回传给用户的助手回复。 */
  reply: string;
  /** 生成步骤序列。 */
  steps: OrchestrationStep[];
}

/** 规划输入。 */
export interface PlanInput {
  agentMode: AgentMode;
  content: string;
  scene: Scene | null;
  /** 用户在 UI 选定模型的模态。 */
  selectedModality: Modality;
  /** 所选模型单次产出上限（用于约束 image 步数量）。 */
  maxOutputs: number;
  /** 可用参考素材摘要（提及节点 + 附件）。 */
  references: Array<{ label: string; kind: string }>;
  /** 模型目录当前可服务的产出模态集合。 */
  availableModalities: Modality[];
}

/** 全局单次编排产出总量上限（防滥用）。 */
const MAX_TOTAL_OUTPUTS = 8;

/** 把任意值收敛为合法步骤；非法则返回 null。 */
function sanitizeStep(
  raw: unknown,
  input: PlanInput,
  hasRefs: boolean,
): OrchestrationStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  let modality = String(r.modality ?? input.selectedModality) as Modality;
  if (modality !== 'image' && modality !== 'video') modality = 'image';
  // 仅保留目录可服务的模态
  if (!input.availableModalities.includes(modality)) return null;

  let count = Math.round(Number(r.count ?? 1));
  if (!Number.isFinite(count) || count < 1) count = 1;
  count = Math.min(count, modality === 'image' ? input.maxOutputs : 1);

  const prompt = typeof r.prompt === 'string' && r.prompt.trim() ? r.prompt.trim() : input.content;

  let referenceRole = String(r.referenceRole ?? '') as OrchestrationStep['referenceRole'];
  if (!['content', 'style', 'first_frame'].includes(referenceRole)) {
    referenceRole = modality === 'video' ? 'first_frame' : 'content';
  }
  const useReferences = hasRefs && r.useReferences !== false;

  return { modality, count, prompt, referenceRole, useReferences };
}

/** 钳制计划的步骤总产出不超过全局上限。 */
function capTotalOutputs(steps: OrchestrationStep[]): OrchestrationStep[] {
  const capped: OrchestrationStep[] = [];
  let total = 0;
  for (const step of steps) {
    if (total >= MAX_TOTAL_OUTPUTS) break;
    const allow = Math.min(step.count, MAX_TOTAL_OUTPUTS - total);
    if (allow < 1) break;
    capped.push({ ...step, count: allow });
    total += allow;
  }
  return capped;
}

/** 确定性兜底规划（无 LLM 时）。 */
function fallbackPlan(input: PlanInput): OrchestrationPlan {
  const hasRefs = input.references.length > 0;
  const modality: 'image' | 'video' =
    input.selectedModality === 'video' ? 'video' : 'image';
  const role: OrchestrationStep['referenceRole'] = modality === 'video' ? 'first_frame' : 'content';

  let count = 1;
  let prompt = input.content;
  if (input.agentMode === 'scene') {
    count = modality === 'image' ? Math.min(sceneGenerationCount(input.scene), input.maxOutputs) : 1;
    prompt = composeScenePrompt(input.scene, input.content);
  } else if (input.agentMode === 'orchestrate') {
    count = Math.min(parseCountHeuristic(input.content), input.maxOutputs);
  }

  const reply =
    input.agentMode === 'scene'
      ? '正在按所选场景为你产出成套物料，请稍候。'
      : input.agentMode === 'orchestrate'
        ? '正在理解你的想法并编排生成，请稍候。'
        : '好的，正在为你生成。';

  return {
    reply,
    steps: capTotalOutputs([{ modality, count, prompt, referenceRole: role, useReferences: hasRefs }]),
  };
}

/** 无 LLM 时从中文数量词粗解析期望产出数（仅兜底用）。 */
export function parseCountHeuristic(content: string): number {
  const cnMap: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 };
  const cn = content.match(/[一二两三四]/)?.[0];
  if (cn && cnMap[cn]) return Math.min(cnMap[cn], 4);
  const digit = content.match(/([1-9])\s*(?:张|个|版|幅)/)?.[1];
  if (digit) return Math.min(Number(digit), 4);
  return 1;
}

/** 构造 LLM 规划的系统提示。 */
function planSystemPrompt(input: PlanInput): string {
  return [
    '你是 NeoCanvas 的设计编排智能体。把用户意图翻译为一个 JSON 编排计划。',
    '严格输出如下 JSON（不要额外文字）：',
    '{"reply": string, "steps": [{"modality": "image"|"video", "count": number, "prompt": string, "referenceRole": "content"|"style"|"first_frame", "useReferences": boolean}]}',
    `- reply：用简洁中文（不超过 3 句）确认你的理解与落位方式。`,
    `- 可用产出模态：${input.availableModalities.join(', ')}；只能使用其中的模态。`,
    `- 图像步 count 不超过 ${input.maxOutputs}；视频步 count 固定为 1。`,
    `- 允许多步骤以表达序列编排（例如先出多张图、再据其出一段视频，视频步 referenceRole 用 first_frame）。`,
    input.references.length > 0
      ? `- 可用参考素材：${input.references.map((r) => `${r.label}(${r.kind})`).join('、')}；按需在步骤中 useReferences=true 并选择合适 referenceRole。`
      : '- 当前无参考素材，useReferences 一律为 false。',
    input.scene ? `- 当前创作场景：${input.scene}，请贴合该场景。` : '',
    '- prompt 用具体、可生成的中文描述，融入用户意图与场景。',
    '- 若用户要海报 / banner / 封面 / 详情页 / 宣传图等平面设计物料：prompt 必须描述一张完整的版式化设计稿——主体清晰、有设计感的背景、统一配色、构图均衡、为标题与卖点预留充足留白与放置区，倾向竖版构图；而非一张写实照片。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成编排计划。配置了 LLM 则由其结构化产出，否则确定性兜底。
 *
 * @param input - 规划输入
 * @returns 经校验与上限钳制的编排计划
 */
export async function buildPlan(input: PlanInput): Promise<OrchestrationPlan> {
  if (!isLlmConfigured()) return fallbackPlan(input);

  try {
    const messages: LlmMessage[] = [
      { role: 'system', content: planSystemPrompt(input) },
      { role: 'user', content: input.content },
    ];
    const raw = await getLlmAdapter().complete(messages, { json: true, temperature: 0.4 });
    const parsed = JSON.parse(raw) as { reply?: unknown; steps?: unknown };
    const hasRefs = input.references.length > 0;
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s) => sanitizeStep(s, input, hasRefs)).filter((s): s is OrchestrationStep => s !== null)
      : [];
    const finalSteps = steps.length > 0 ? capTotalOutputs(steps) : fallbackPlan(input).steps;
    const reply =
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : '已理解你的需求，正在为你编排生成。';
    return { reply, steps: finalSteps };
  } catch {
    // LLM 不可用 / 输出不可解析时回退，保证可用性
    return fallbackPlan(input);
  }
}
