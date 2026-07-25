/**
 * 本地 Supabase 魔法链接自动完成端点。
 *
 * Supabase CLI 把认证邮件投递到 Mailpit。本端点仅在公开 Supabase URL 指向
 * localhost / 127.0.0.1 时启用，从 Mailpit 读取本次刚生成的验证令牌，供浏览器直接完成验证。
 * 托管 Supabase 环境始终返回 404，绝不绕过正式环境的邮箱所有权验证。
 *
 * @module app/api/auth/local-login/route
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getPublicEnv, getServerSupabaseUrl } from '@/lib/env';

/** 请求体契约。 */
const requestSchema = z.object({
  email: z.string().email(),
  sentAfter: z.string().datetime(),
});

/** Mailpit 消息摘要。 */
interface MailpitMessageSummary {
  ID: string;
  Created: string;
  To: Array<{ Address: string }>;
}

/** Mailpit 消息列表响应。 */
interface MailpitListResponse {
  messages?: MailpitMessageSummary[];
}

/** Mailpit 消息详情。 */
interface MailpitMessageDetail {
  HTML?: string;
  Text?: string;
}

/** 本地邮箱登录会产生的 Supabase 邮件验证类型。 */
const LOCAL_EMAIL_OTP_TYPES = ['signup', 'magiclink'] as const;

/** 判断邮件链接中的类型是否属于本地邮箱登录流程。 */
function isLocalEmailOtpType(
  value: string | null,
): value is (typeof LOCAL_EMAIL_OTP_TYPES)[number] {
  return LOCAL_EMAIL_OTP_TYPES.some((type) => type === value);
}

/** 判断 URL 是否为 Supabase CLI 本地地址。 */
function isLocalSupabase(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/** 短暂等待 Mailpit 完成异步投递。 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 从邮件正文中提取 Supabase verify URL。 */
function extractVerifyUrl(message: MailpitMessageDetail): string | null {
  const source = message.HTML || message.Text || '';
  const match = source.match(/https?:\/\/[^"'<>\s]+\/auth\/v1\/verify\?[^"'<>\s]+/u);
  return match ? match[0].replaceAll('&amp;', '&') : null;
}

/**
 * 返回本次本地登录邮件中的一次性验证令牌。
 *
 * @param request - 含邮箱与发送起始时间的请求
 * @returns 一次性验证令牌或错误响应
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const publicSupabaseUrl = new URL(getPublicEnv().supabaseUrl);
  if (!isLocalSupabase(publicSupabaseUrl)) {
    return NextResponse.json({ error: 'not_available' }, { status: 404 });
  }

  const internalSupabaseUrl = new URL(getServerSupabaseUrl());
  const mailpitBaseUrl = `${internalSupabaseUrl.protocol}//${internalSupabaseUrl.hostname}:54324`;
  const sentAfter = new Date(parsed.data.sentAfter).getTime() - 5_000;
  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  let failureStage = 'message_not_found';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      failureStage = 'mailpit_list';
      const listResponse = await fetch(`${mailpitBaseUrl}/api/v1/messages`, { cache: 'no-store' });
      if (!listResponse.ok) throw new Error(`Mailpit list failed: ${listResponse.status}`);
      const list = (await listResponse.json()) as MailpitListResponse;
      const candidate = (list.messages ?? [])
        .filter(
          (message) =>
            new Date(message.Created).getTime() >= sentAfter &&
            message.To.some((recipient) => recipient.Address.toLowerCase() === normalizedEmail),
        )
        .sort((left, right) => Date.parse(right.Created) - Date.parse(left.Created))[0];

      if (candidate) {
        failureStage = 'message_detail';
        const detailResponse = await fetch(`${mailpitBaseUrl}/api/v1/message/${candidate.ID}`, {
          cache: 'no-store',
        });
        if (!detailResponse.ok) throw new Error(`Mailpit detail failed: ${detailResponse.status}`);
        failureStage = 'message_parse';
        const verifyUrl = extractVerifyUrl((await detailResponse.json()) as MailpitMessageDetail);
        if (verifyUrl) {
          failureStage = 'link_parse';
          const verifyUri = new URL(verifyUrl);
          failureStage = 'link_validation';
          if (
            verifyUri.hostname === publicSupabaseUrl.hostname &&
            verifyUri.port === publicSupabaseUrl.port &&
            verifyUri.pathname === '/auth/v1/verify'
          ) {
            const tokenHash = verifyUri.searchParams.get('token');
            const verifyType = verifyUri.searchParams.get('type');
            if (tokenHash && isLocalEmailOtpType(verifyType)) {
              return NextResponse.json({ tokenHash, verifyType });
            }
          }
        }
      } else {
        failureStage = 'message_not_found';
      }
    } catch {
      // Mailpit 启动或投递存在短暂延迟，统一进入下一轮重试。
    }

    await wait(100);
  }

  return NextResponse.json({ error: 'local_login_failed', stage: failureStage }, { status: 504 });
}
