/**
 * Next.js 配置。
 *
 * - App Router 默认开启，无需显式声明。
 * - `images.remotePatterns` 放行 Supabase Storage 的签名 URL 域名，使
 *   `next/image` 可直接渲染存储桶中的媒体；具体域名由环境变量注入。
 * - 本地端到端测试统一使用 127.0.0.1，显式列入开发资源来源。
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker 生产镜像只携带 Next.js 自动追踪出的最小运行依赖。
  output: 'standalone',
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1'],
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
