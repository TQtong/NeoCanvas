/**
 * 海报版式合成（第 05 篇第七节扩展）。
 *
 * 「真海报」的关键认识：原始文生图模型无法稳定渲染清晰中文文字（实测 Kolors / Qwen-Image
 * 均糊字）。竞品的清晰文字海报本质是「分层文档」——AI 只生成背景/主体图，文字作为独立图层
 * 由应用以真字体渲染。NeoCanvas 本就是画布（图片节点 + 文字节点皆为一等公民），故可原生地
 * 「组合」出海报，而非把文字烤进像素：
 *
 *   背景图（图片节点，z=0，提示词显式声明「画面不要出现文字」）
 *   + 标题/副标题/卖点/CTA（文字节点，z≥10，应用渲染、清晰可改）
 *
 * 本模块负责：识别海报意图、由编排 LLM 产出结构化版式（背景提示词 + 文字元素），
 * 并把文字元素换算为 `canvas_nodes` 文字节点插入行（叠在背景之上）。
 *
 * @module functions/_shared/poster
 */

import { type Scene } from './types.ts';
import { getLlmAdapter, isLlmConfigured, type LlmMessage } from './adapters/text.ts';

/** 海报在画布上的默认尺寸（flow px，约 3:4 竖版）。 */
export const POSTER_WIDTH = 450;
export const POSTER_HEIGHT = 600;
/** 海报背景图的生成比例（与画布尺寸一致，避免拉伸）。 */
export const POSTER_ASPECT_RATIO = '3:4';

/** 文字节点字体族：与前端 lib/canvas/constants 的 DEFAULT_FONT_FAMILY 一致（中英混排）。 */
const POSTER_FONT_FAMILY =
  'var(--font-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 海报文字元素角色。 */
export type PosterTextRole = 'title' | 'subtitle' | 'slogan' | 'feature' | 'cta' | 'brand';

/** 一个文字元素（位置/字号以画布占比表达，0~1）。 */
export interface PosterTextElement {
  content: string;
  role: PosterTextRole;
  /** 左上角横向占比。 */
  xPct: number;
  /** 左上角纵向占比。 */
  yPct: number;
  /** 宽度占比。 */
  wPct: number;
  /** 字号占海报高度比例（标题约 0.06~0.09）。 */
  fontPct: number;
  /** 十六进制颜色（需在浅色背景上清晰）。 */
  color: string;
  align: 'left' | 'center' | 'right';
  bold: boolean;
}

/** 海报版式方案。 */
export interface PosterLayout {
  /** 流式回传给用户的助手回复。 */
  reply: string;
  /** 背景图提示词。 */
  backgroundPrompt: string;
  /** 文字元素序列。 */
  texts: PosterTextElement[];
}

/** 命中即判为海报意图的关键词。 */
const POSTER_KEYWORDS = [
  '海报',
  'poster',
  'banner',
  '横幅',
  '封面',
  '详情页',
  '宣传图',
  '宣传海报',
  '主视觉',
  'kv',
  '长图',
  '展架',
  'dm单',
  '传单',
];

/**
 * 识别用户意图是否为「海报 / 平面设计物料」。
 *
 * @param content - 用户消息文本
 * @returns 是否为海报意图
 */
export function detectPosterIntent(content: string): boolean {
  const lower = content.toLowerCase();
  return POSTER_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

/** 数值钳制。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 校验 / 收敛十六进制颜色；非法时回退为深灰。 */
function sanitizeColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value.trim())) return value.trim();
  return '#2b2b2b';
}

/** 把任意值收敛为合法文字元素；非法返回 null。 */
function sanitizeTextElement(raw: unknown): PosterTextElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r.content === 'string' ? r.content.trim() : '';
  if (!content) return null;

  let role = String(r.role ?? 'feature') as PosterTextRole;
  if (!['title', 'subtitle', 'slogan', 'feature', 'cta', 'brand'].includes(role)) role = 'feature';

  let align = String(r.align ?? 'left') as PosterTextElement['align'];
  if (!['left', 'center', 'right'].includes(align)) align = 'left';

  return {
    content: content.slice(0, 60),
    role,
    xPct: clamp(Number(r.xPct), 0, 0.95),
    yPct: clamp(Number(r.yPct), 0, 0.95),
    wPct: clamp(Number(r.wPct ?? 0.5), 0.1, 0.95),
    fontPct: clamp(Number(r.fontPct ?? 0.04), 0.02, 0.14),
    color: sanitizeColor(r.color),
    align,
    bold: r.bold !== false && (role === 'title' || role === 'cta' || r.bold === true),
  };
}

/** 确定性兜底标题：剥除「生成/制作/帮我/一张…」等动词与量词，保留主题。 */
function fallbackTitle(content: string): string {
  const cleaned = content
    .replace(/(帮我|请|给我|来|做|制作|生成|设计|画|出)一?(张|个|版|幅|份)?/g, '')
    .replace(/海报|banner|横幅|封面|详情页|宣传图|主视觉|长图|kv/gi, '')
    .trim();
  return cleaned || '精彩主题';
}

/** 无 LLM / 解析失败时的确定性海报方案。 */
function fallbackPosterLayout(content: string): PosterLayout {
  const title = fallbackTitle(content);
  return {
    reply: '好的，正在为你合成一张海报：右侧主体图 + 左侧可编辑文字。',
    backgroundPrompt: `${content}，竖版海报背景，主体置于画面右侧约三分之二，左侧与顶部、底部留出干净的浅色空白区用于排版，高级、有设计感、配色统一柔和`,
    texts: [
      {
        content: title.slice(0, 12),
        role: 'title',
        xPct: 0.08,
        yPct: 0.1,
        wPct: 0.5,
        fontPct: 0.085,
        color: '#2b2b2b',
        align: 'left',
        bold: true,
      },
      {
        content: '遇见更好的选择',
        role: 'subtitle',
        xPct: 0.08,
        yPct: 0.26,
        wPct: 0.46,
        fontPct: 0.034,
        color: '#5a5145',
        align: 'left',
        bold: false,
      },
    ],
  };
}

/** 构造海报版式的 LLM 系统提示。 */
function posterSystemPrompt(scene: Scene | null): string {
  return [
    '你是 NeoCanvas 的海报版式设计师。把用户意图翻译为一份 JSON 海报版式方案，严格只输出 JSON：',
    '{"reply": string, "backgroundPrompt": string, "texts": [{"content": string, "role": "title"|"subtitle"|"slogan"|"feature"|"cta"|"brand", "xPct": number, "yPct": number, "wPct": number, "fontPct": number, "color": string, "align": "left"|"center"|"right", "bold": boolean}]}',
    '- reply：用简洁中文（≤2 句）说明你的海报构思与排版方式。',
    '- backgroundPrompt：一张「竖版海报背景」的中文提示词。要求：主体（贴合用户意图）放在画面右侧约三分之二，左侧与顶部/底部留出干净的浅色空白区用于排版；高级、有设计感、配色统一。',
    '  关键：backgroundPrompt 必须显式写「画面中不要出现任何文字」，因为文字会由前端以图层叠加，不能让背景把文字烤进去。',
    '- texts：2~6 个文字元素，落在背景的留白区（通常左侧栏、顶部、底部），不要压在主体上。',
    '  xPct/yPct 为元素左上角在海报上的占比（0~1），wPct 为宽度占比；fontPct 为字号占海报高度比例（主标题约 0.07~0.09，副标题约 0.03~0.04，卖点/正文约 0.022~0.03）。',
    '  必含一个 title 主标题；可含 subtitle 副标题、slogan 标语、feature 卖点（可多条）、cta 行动按钮、brand 品牌名。文案贴合用户意图，中文为主、可点缀英文。',
    '  color 用十六进制，需在浅色背景上清晰（深色或品牌色）。',
    scene ? `- 当前创作场景：${scene}，版式与文案请贴合该场景。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成海报版式方案。配置了编排 LLM 则由其结构化产出，否则确定性兜底。
 *
 * @param content - 用户意图文本
 * @param scene - 创作场景
 * @returns 经校验的海报版式
 */
export async function buildPosterLayout(content: string, scene: Scene | null): Promise<PosterLayout> {
  if (!isLlmConfigured()) return fallbackPosterLayout(content);

  try {
    const messages: LlmMessage[] = [
      { role: 'system', content: posterSystemPrompt(scene) },
      { role: 'user', content },
    ];
    const raw = await getLlmAdapter().complete(messages, { json: true, temperature: 0.5 });
    const parsed = JSON.parse(raw) as {
      reply?: unknown;
      backgroundPrompt?: unknown;
      texts?: unknown;
    };

    const texts = Array.isArray(parsed.texts)
      ? parsed.texts
          .map(sanitizeTextElement)
          .filter((t): t is PosterTextElement => t !== null)
          .slice(0, 6)
      : [];
    if (texts.length === 0) return fallbackPosterLayout(content);
    // 保证至少有一个 title（取第一个并升级为标题）
    if (!texts.some((t) => t.role === 'title')) texts[0].role = 'title';

    let backgroundPrompt =
      typeof parsed.backgroundPrompt === 'string' && parsed.backgroundPrompt.trim()
        ? parsed.backgroundPrompt.trim()
        : fallbackPosterLayout(content).backgroundPrompt;
    // 兜底：无论 LLM 是否写了，都强制声明「无文字」，避免背景烤进糊字
    if (!/不要出现|不出现|no text|无文字|不含文字/i.test(backgroundPrompt)) {
      backgroundPrompt += '，画面中不要出现任何文字';
    }

    const reply =
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : '好的，正在为你合成海报：右侧主体图 + 左侧可编辑文字。';

    return { reply, backgroundPrompt, texts };
  } catch {
    return fallbackPosterLayout(content);
  }
}

/** 海报背景图在画布上的居中落位（以原点为中心）。 */
export function posterPlacement(): { x: number; y: number; width: number; height: number } {
  return { x: -POSTER_WIDTH / 2, y: -POSTER_HEIGHT / 2, width: POSTER_WIDTH, height: POSTER_HEIGHT };
}

/** 由用户消息 id 派生稳定的文字节点 id（uuid 形状），便于 upsert 去重（连点/重试不重复建）。 */
function posterTextNodeId(messageId: string, index: number): string {
  const suffix = (index + 16).toString(16).padStart(2, '0').slice(-2);
  return messageId.slice(0, -2) + suffix;
}

/** 估算文字节点高度：按可视字宽折行（CJK 约 1×字号，拉丁约 0.56×字号）。 */
function estimateTextHeight(content: string, fontSize: number, widthPx: number, lineHeight: number): number {
  let visual = 0;
  for (const ch of content) {
    const isCjkWide = /[　-〿㐀-鿿＀-￯]/.test(ch);
    visual += (isCjkWide ? 1 : 0.56) * fontSize;
  }
  const lines = Math.max(1, Math.ceil(visual / Math.max(widthPx, fontSize)));
  return Math.ceil(lines * fontSize * lineHeight + 6);
}

/** 文字节点插入行（与 canvas_nodes 列对齐）。 */
export interface PosterTextNodeRow {
  id: string;
  project_id: string;
  type: 'text';
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  rotation: number;
  z_index: number;
  parent_id: null;
  data: Record<string, unknown>;
  created_by: string;
}

/**
 * 把海报版式的文字元素换算为画布文字节点插入行（叠在背景图之上，z≥10）。
 *
 * @param layout - 海报版式
 * @param placement - 背景图落位（文字坐标相对于此）
 * @param projectId - 项目标识
 * @param userId - 创建者
 * @param messageId - 触发的用户消息 id（用于派生稳定节点 id）
 * @returns canvas_nodes 文字节点插入行
 */
export function buildPosterTextNodeRows(
  layout: PosterLayout,
  placement: { x: number; y: number; width: number; height: number },
  projectId: string,
  userId: string,
  messageId: string,
): PosterTextNodeRow[] {
  const lineHeight = 1.3;
  return layout.texts.map((el, index) => {
    const fontSize = Math.round(clamp(el.fontPct, 0.02, 0.14) * placement.height);
    const width = Math.round(clamp(el.wPct, 0.1, 0.95) * placement.width);
    const x = placement.x + clamp(el.xPct, 0, 0.95) * placement.width;
    const y = placement.y + clamp(el.yPct, 0, 0.95) * placement.height;
    const height = estimateTextHeight(el.content, fontSize, width, lineHeight);
    return {
      id: posterTextNodeId(messageId, index),
      project_id: projectId,
      type: 'text',
      position_x: Math.round(x),
      position_y: Math.round(y),
      width,
      height,
      rotation: 0,
      // 叠在背景图（z=0）之上；按角色与顺序递增，标题更靠上层
      z_index: 10 + index,
      parent_id: null,
      data: {
        text: el.content,
        fontFamily: POSTER_FONT_FAMILY,
        fontSize,
        fontWeight: el.bold ? 700 : 500,
        lineHeight,
        letterSpacing: 0,
        align: el.align,
        color: el.color,
        autoWrap: true,
        italic: false,
        underline: false,
        backgroundColor: 'transparent',
      },
      created_by: userId,
    };
  });
}
