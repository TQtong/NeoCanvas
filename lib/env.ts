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
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000';

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      '缺少 Supabase 公开环境变量：请在 .env.local 配置 NEXT_PUBLIC_SUPABASE_URL 与 NEXT_PUBLIC_SUPABASE_ANON_KEY。',
    );
  }

  return { supabaseUrl, supabaseAnonKey, siteUrl };
}
