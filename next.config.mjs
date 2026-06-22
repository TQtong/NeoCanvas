/**
 * Next.js 配置。
 *
 * - App Router 默认开启，无需显式声明。
 * - `images.remotePatterns` 放行 Supabase Storage 的签名 URL 域名，使
 *   `next/image` 可直接渲染存储桶中的媒体；具体域名由环境变量注入。
 * - `serverActions.bodySizeLimit` 适度放宽，以容纳发起创作时附带的小型参考图。
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '8mb',
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
      {
        protocol: 'https',
        hostname: '**.supabase.in',
      },
    ],
  },
  // Edge Functions（supabase/functions）以 Deno 运行，不参与 Next 构建。
  // 已在 tsconfig 中排除，此处无需额外处理。
};

export default nextConfig;
