/**
 * 内容安全审核（第 05 篇第八节）。
 *
 * 覆盖输入与产出两端：输入端对提示词与参考图做合规检查，产出端对生成结果做安全过滤，
 * 违规产出不落画布；审核结论与拦截原因记录于生成任务（由调用方写回 generations）。
 *
 * 策略以可配置方式维护：违规词 / 正则取自数据库 `moderation_policies` 表与环境变量
 * `CONTENT_BLOCKLIST`（逗号分隔），构成第一层廉价匹配；在配置了审核引擎密钥
 * （`MODERATION_API_KEY` 或 `OPENAI_API_KEY`）时，叠加 OpenAI omni-moderation 对文本与
 * 图像做语义级审核。两层任一命中即判违规。
 *
 * @module functions/_shared/moderation
 */

import { ApiException } from './response.ts';
import { type SupabaseClient } from './supabase.ts';

/** 一条可配置策略词。 */
interface PolicyTerm {
  term: string;
  match_type: 'substring' | 'regex';
  severity: 'block' | 'warn';
}

/** 进程内缓存的策略（边缘实例存活期间复用，避免每次查库）。 */
let cachedPolicy: PolicyTerm[] | null = null;

/** 读取可配置策略：环境变量补充 + 数据库表，合并去重，进程内缓存。 */
async function loadPolicy(admin: SupabaseClient): Promise<PolicyTerm[]> {
  if (cachedPolicy) return cachedPolicy;
  const terms: PolicyTerm[] = [];

  const envList = Deno.env.get('CONTENT_BLOCKLIST');
  if (envList) {
    for (const t of envList.split(',').map((s) => s.trim()).filter(Boolean)) {
      terms.push({ term: t, match_type: 'substring', severity: 'block' });
    }
  }

  const { data } = await admin
    .from('moderation_policies')
    .select('term, match_type, severity')
    .eq('is_active', true);
  for (const row of (data ?? []) as PolicyTerm[]) terms.push(row);

  cachedPolicy = terms;
  return terms;
}

/** 对文本运行策略匹配，命中 block 返回命中词，否则 null。 */
function matchText(text: string, policy: PolicyTerm[]): string | null {
  const lower = text.toLowerCase();
  for (const p of policy) {
    if (p.severity !== 'block') continue;
    if (p.match_type === 'regex') {
      try {
        if (new RegExp(p.term, 'i').test(text)) return p.term;
      } catch {
        // 跳过非法正则，避免一条坏策略阻断全部审核
      }
    } else if (lower.includes(p.term.toLowerCase())) {
      return p.term;
    }
  }
  return null;
}

/** omni-moderation 输入分块。 */
type OmniInput = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * 调用 OpenAI omni-moderation 审核文本 / 图像；命中返回类目串，否则 null。
 * 未配置密钥或审核服务异常时返回 null（不阻断主流程，由上层第一层策略兜底）。
 */
async function omniModerate(inputs: OmniInput[]): Promise<string | null> {
  if (inputs.length === 0) return null;
  const key = Deno.env.get('MODERATION_API_KEY') ?? Deno.env.get('OPENAI_API_KEY');
  if (!key) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: inputs }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
    };
    for (const r of json.results ?? []) {
      if (r.flagged) {
        const cats = Object.entries(r.categories ?? {})
          .filter(([, v]) => v)
          .map(([k]) => k);
        return cats.length > 0 ? cats.join(',') : 'flagged';
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 输入端审核：提示词文本。命中即抛 content_blocked。
 *
 * @param admin - 管理员客户端（读取策略表）
 * @param prompt - 提示词
 * @throws {ApiException} content_blocked
 */
export async function moderatePromptText(admin: SupabaseClient, prompt: string): Promise<void> {
  const policy = await loadPolicy(admin);
  const hit = matchText(prompt, policy);
  if (hit) throw new ApiException('content_blocked', `提示词触发内容安全策略：${hit}`);
  const semantic = await omniModerate([{ type: 'text', text: prompt }]);
  if (semantic) throw new ApiException('content_blocked', `提示词触发内容安全审核：${semantic}`);
}

/**
 * 输入端审核：参考图。任一命中即抛 content_blocked。
 *
 * @param urls - 参考图可访问 URL（签名 URL）
 * @throws {ApiException} content_blocked
 */
export async function moderateReferenceImages(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const hit = await omniModerate(urls.map((url) => ({ type: 'image_url', image_url: { url } })));
  if (hit) throw new ApiException('content_blocked', `参考图触发内容安全审核：${hit}`);
}

/**
 * 产出端审核：对产出图像 URL 做安全过滤。返回拦截原因（命中类目）或 null（通过）。
 * 视频产出无法以图像审核引擎判定，交由提供商自带安全策略与人工抽检，返回 null。
 *
 * @param urls - 产出图像可访问 URL
 * @returns 命中类目串或 null
 */
export async function moderateOutputImages(urls: string[]): Promise<string | null> {
  if (urls.length === 0) return null;
  return await omniModerate(urls.map((url) => ({ type: 'image_url', image_url: { url } })));
}
