# NeoCanvas 部署与本地运行指南

本指南覆盖从零把 NeoCanvas 跑起来所需的全部步骤：Supabase 后端（数据库 / 存储 /
实时 / 队列 / 定时任务 / Edge Functions）与 Next.js 前端。

## 一、前置依赖

- Node.js ≥ 20、npm ≥ 10
- Supabase 账号与 [Supabase CLI](https://supabase.com/docs/guides/cli)
- 各模型提供商密钥（按需）：OpenAI、Google Gemini、火山方舟 Ark、fal.ai、Replicate

## 二、克隆与安装

```bash
npm install
cp .env.example .env.local   # 填入下文的变量
```

## 三、创建 Supabase 项目

1. 在 Supabase 控制台新建项目（建议区域：新加坡 `ap-southeast-1`）。
2. 记下 `Project URL`、`anon key`、`service_role key`。
3. 关联 CLI：

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

## 四、应用数据库迁移与种子

迁移位于 `supabase/migrations/`，按序建立枚举、表、索引、RLS、函数触发器、Storage 桶、
Realtime 发布、队列与定时任务。种子位于 `supabase/seed.sql`（模型目录）。

```bash
supabase db push                       # 应用全部迁移
psql "$DATABASE_URL" -f supabase/seed.sql   # 写入 model_catalog 种子
```

> Storage 三个桶（`avatars` / `uploads` / `generations`）由迁移 0007 自动创建并配置访问策略。
> Realtime 发布、`pg_cron` 定时任务、`pgmq` 队列由迁移 0008/0009 自动配置。

## 五、配置数据库回调 Edge Function 的机密（Vault）

`pg_cron` 与触发器需以服务角色回调 Edge Function（轮询 / 队列消费）。在 SQL 编辑器执行：

```sql
select vault.create_secret('https://<your-ref>.supabase.co/functions/v1', 'edge_base_url');
select vault.create_secret('<service_role_key>', 'service_role_key');
-- 可选：覆盖生成超时（毫秒）
select vault.create_secret('600000', 'generation_timeout_ms');
```

## 六、部署 Edge Functions 与函数密钥

```bash
supabase functions deploy create-project submit-generation agent-orchestrate \
  process-generation-queue poll-generations generation-webhook export-canvas

# 注入函数密钥（外部模型密钥仅存于此，绝不下发客户端）
supabase secrets set \
  OPENAI_API_KEY=sk-... \
  GOOGLE_API_KEY=... \
  ARK_API_KEY=... \
  FAL_API_KEY=... \
  REPLICATE_API_TOKEN=... \
  ORCHESTRATOR_LLM_MODEL=gpt-4o-mini \
  GENERATION_WEBHOOK_SECRET=<random> \
  MAX_INFLIGHT_GENERATIONS=8
```

> `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 平台自动注入
> 到函数环境，无需手动设置。`config.toml` 已为三个内部函数关闭网关 JWT 校验。

## 七、配置认证

- 在 Auth → URL Configuration 设置 `Site URL = http://localhost:3000`，并把
  `http://localhost:3000/auth/callback` 加入 Redirect URLs。
- 如需 Google 登录，在 Auth → Providers 启用 Google 并填入 OAuth 凭据。
- 邮箱魔法链接默认开启（`config.toml` 中 `enable_confirmations = false` 便于本地体验）。

## 八、配置前端环境变量

编辑 `.env.local`：

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

## 九、运行

```bash
npm run dev        # http://localhost:3000
npm run typecheck  # 类型检查（应为 0 错误）
npm run lint       # 代码规范
npm run build      # 生产构建
```

## 十、验证链路

1. 打开主页 → 输入想法、选模型、点击发送 → 自动建项目并进入设计页。
2. 设计页应显示生成占位卡片，待 Edge Functions 完成后经 Realtime 替换为成品。
3. 在右侧对话继续追加指令、`@` 提及画布元素、上传附件做多轮迭代。
4. 在画布上用底部工具栏添加文本 / 形状 / 手绘 / 画板，拖拽缩放旋转、撤销重做。
5. 返回主页应在「最近项目」看到该项目的缩略与更新时间。

## 十一、生产部署

- 前端部署到 Vercel：设置上述三个 `NEXT_PUBLIC_*` 环境变量。
- 区分 dev / staging / prod 三套独立的 Supabase 项目与前端部署，密钥不进版本库。
- 可观测性：Edge Function 日志、数据库性能、Realtime 连接、Storage 用量在 Supabase 控制台查看。

## 模型说明

`model_catalog` 种子内置：GPT Image 2（OpenAI，默认）、Seedance 2.0（Ark，视频，异步）、
Nano Banana Pro（Google，图像）。Seedream（Ark，图像）已登记但未上架。新增模型只需：
实现适配器（`supabase/functions/_shared/adapters/`）→ 在 `registry.ts` 登记 → 在
`model_catalog` 追加一行；前端选择条、参数 UI 与流水线由数据驱动自动纳入。
各模型的提供商端点 id 可经 `model_catalog.default_params.providerModel` 或环境变量覆盖
（见 `_shared/pipeline.ts` 的 `resolveProviderModel`）。
