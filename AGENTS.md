# NeoCanvas — 项目工程说明（AGENTS.md）

NeoCanvas 是一款「对话驱动 + 无限画布」的 AI 设计代理产品。本文件是仓库的工程总纲，
设计来源为 `docs/` 下的七份设计文档（00 总览 / 01 需求 / 02 架构 / 03 数据 / 04 前端 /
05 AI / 06 接口）。实现必须忠于这些文档，**禁止简化实现、占位符与 TODO**。

## 技术栈

- 前端：Next.js 15 App Router + React 19 + TypeScript 严格模式
- 画布：`@xyflow/react`（React Flow v12）—— 每个画布元素是一个自定义节点
- 状态：Zustand（画布库 / 对话库 / 会话库三库）
- 后端：Supabase（PostgreSQL + Auth + Storage + Realtime + Edge Functions + pg_cron + Queues）
- AI：模型适配器抽象，对接 OpenAI / Google / 火山方舟 Ark，预留 fal.ai / Replicate
- 样式：Tailwind CSS（设计令牌见 `tailwind.config.ts` 与 `app/globals.css`）

## 目录结构

```
app/                  路由：主页(/)、设计页(/p/[projectId])、登录、auth/callback、middleware
components/
  canvas/             画布容器、7 类自定义节点、变换层、工具栏、控件、对齐参考线
  chat/               对话面板、消息流、输入框、提及选择器、Agent 下拉、附件上传
  home/               标语区、创作输入框、模型场景选择条、最近项目网格、项目卡片
  ui/                 跨领域基础组件（按钮、弹层、下拉、骨架屏、toast）
  shared/             跨界面信息簇（头像菜单、顶栏）
stores/               canvas-store / chat-store / session-store
lib/
  supabase/           browser / server / middleware 三种客户端工厂
  realtime/           按项目订阅 Realtime 的封装
  storage/            媒体上传与签名 URL
  edge/               Edge Function 调用封装
  canvas/             坐标变换、几何、行<->节点 映射器
  hooks/              领域钩子（projects / canvas / conversation / generation）
  utils/              通用工具（cn、格式化、防抖等）
types/                贯穿前后端的共享类型契约（节点判别联合、生成请求、响应封套、错误码……）
i18n/                 中英文案与语言切换
supabase/
  migrations/         数据库迁移（枚举、表、索引、RLS、函数触发器、storage、realtime）
  functions/          Edge Functions（Deno）：_shared 框架 + 适配器 + 7 个函数
  seed.sql            model_catalog 种子数据
docs/                 七份设计文档（真相来源）
```

## 关键工程约束

- **真相唯一**：数据库是唯一真相之源，客户端状态是其投影，经 Realtime 校正。
- **画布一节点一行**：每个元素是 `canvas_nodes` 一行，按节点粒度实时同步、增量持久化。
- **三段式同步**：乐观更新 → 防抖持久化 → 实时回流校正（含回声抑制）。
- **坐标系**：节点以 flow 坐标存储；屏幕落点必经 `screenToFlowPosition` 换算。几何统一在 `lib/canvas`。
- **密钥不出边缘**：外部模型密钥只在 Edge Functions；service_role 绝不下发客户端。
- **共享类型单点**：`types/` 是前端与 Edge Function 共同引用的契约，枚举字面量与 DB 逐字一致。
- 全量 JSDoc，关键行内注释用中文；同一特性多文件成套交付；ESLint + Prettier 强约束。

## 常用命令

- `npm run dev` 本地开发
- `npm run typecheck` 类型检查（CI 必过）
- `npm run lint` / `npm run format`

## 环境与部署

复制 `.env.example` 为 `.env.local`，填入 Supabase 与各模型密钥。数据库迁移、Storage 桶、
Realtime 发布、pg_cron、Queues 的落地步骤见 `docs/SETUP.md`。Edge Functions 经 Supabase CLI 部署。
