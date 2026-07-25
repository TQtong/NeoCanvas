/**
 * 环境变量访问。
 *
 * 公开变量（NEXT_PUBLIC_*）在浏览器与服务端均可读；私有变量（服务角色、模型密钥）
 * 仅在服务端 / Edge 读取，绝不下发客户端。此处对公开变量做存在性校验，缺失即抛错，
 * 以便在启动阶段尽早暴露配置错误。
 *
 * @module lib/env
 */

/** 公开环境变量集合（可在客户端引用）。 */
export interface PublicEnv {
  /** Supabase 项目 URL。 */
  supabaseUrl: string;
  /** Supabase 匿名公钥。 */
  supabaseAnonKey: string;
  /** 站点地址，用于 OAuth 回调与分享链接。 */
  siteUrl: string;
}

/**
 * 读取并校验公开环境变量。
 *
 * @returns 公开环境变量集合
 * @throws 当必需变量缺失时抛出，提示补齐 .env.local
 */
export function getPublicEnv(): PublicEnv {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // 用 || 而非 ??：在 CI/部署平台上「声明但未赋值」的变量会是空串，?? 不会回退导致
  // OAuth 回调地址变成相对路径而握手失败。trim 后为空一律回退到本地默认地址。
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3100';

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      '缺少 Supabase 公开环境变量：请在 .env.local 配置 NEXT_PUBLIC_SUPABASE_URL 与 NEXT_PUBLIC_SUPABASE_ANON_KEY。',
    );
  }

  return { supabaseUrl, supabaseAnonKey, siteUrl };
}

/**
 * 获取服务端访问 Supabase 的地址。
 *
 * Docker 中浏览器可用宿主机的 `127.0.0.1`，容器服务端却必须通过
 * `host.docker.internal` 访问同一服务，因此允许用非公开变量覆盖服务端地址。
 * 托管 Supabase 无需覆盖，自动复用公开 URL。
 *
 * @returns 服务端可达的 Supabase URL
 */
export function getServerSupabaseUrl(): string {
  const { supabaseUrl } = getPublicEnv();
  return process.env.SUPABASE_INTERNAL_URL?.trim() || supabaseUrl;
}

/**
 * 获取浏览器与服务端共同使用的 Supabase Auth Cookie 名。
 *
 * Docker 服务端可能通过 `host.docker.internal` 访问 Supabase，而浏览器通过公开地址访问。
 * Cookie 名必须始终按公开 URL 推导，否则两端会创建不同的会话存储键。
 *
 * @returns 与 supabase-js 默认规则一致的 Auth Cookie 名
 */
export function getSupabaseAuthCookieName(): string {
  const projectRef = new URL(getPublicEnv().supabaseUrl).hostname.split('.')[0];
  return `sb-${projectRef}-auth-token`;
}

/**
 * 解析本地 Supabase 的邮件预览地址。
 *
 * Supabase CLI 不会把认证邮件投递到公网邮箱，而是交给默认监听 54324 端口的 Mailpit。
 * 托管 Supabase 返回 `null`，避免正式环境显示本地开发入口。
 *
 * @returns 本地 Mailpit URL；非本地 Supabase 时返回 `null`
 */
export function getLocalAuthInboxUrl(): string | null {
  const { supabaseUrl } = getPublicEnv();

  try {
    const url = new URL(supabaseUrl);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
    return `${url.protocol}//${url.hostname}:54324`;
  } catch {
    return null;
  }
}
