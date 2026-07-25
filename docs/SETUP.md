# NeoCanvas 一键 Docker 部署与后端初始化指南

新电脑的推荐部署方式是运行仓库根目录的 **`deploy-docker.cmd`**。脚本会完成环境配置、镜像构建、
容器启动和健康检查；部署人员不需要安装 Node.js 或手工执行 `npm` 命令。

NeoCanvas 的本地统一端口是 **`3100`**。Docker 端口、Supabase Auth 回调和
`NEXT_PUBLIC_SITE_URL` 必须使用同一个地址。

> **干净部署原则：** 新电脑必须连接一个新建的空 Supabase 项目。只部署仓库中的代码、数据库迁移、
> 种子目录和 Edge Functions；不迁移当前测试环境的数据库记录、Auth 用户、Storage 对象或 Docker 卷。

## 一、部署拓扑与干净环境原则

Docker Compose 运行 Next.js 前端容器；数据库、认证、文件、实时同步和 Edge Functions 继续运行在
托管 Supabase。这样保持 `docs/02-系统架构设计.md` 规定的部署架构，也避免在现场维护 PostgreSQL、
Realtime、Storage、Auth、Kong 和 Edge Runtime 等完整 Supabase 自托管服务。

全新部署只需要携带：

1. 本仓库的 Git 提交或源码压缩包。
2. 在目标环境新建的 Supabase 项目的 `Project URL` 和 publishable/anon key。
3. 用于初始化该新项目的 Supabase 账号、项目 ref、数据库密码和 `service_role key`。
4. 模型密钥。可以部署为系统级 Edge Function secrets，也可以由用户登录后在
   「设置 → 模型提供商」中配置 BYOK。

不要复制或导入以下测试环境内容：

- PostgreSQL 业务数据或数据库 dump。
- Supabase Auth 用户和登录会话。
- `avatars`、`uploads`、`generations` Storage 对象。
- Supabase 本地 Docker 卷或其他 Docker 数据卷。
- 原电脑的 `.env.docker`、`.env.local`、`node_modules/` 和 `.next/`。

新环境的表、RLS、Storage 桶、Realtime、队列和定时任务由 `supabase/migrations/` 重建；
`supabase/seed.sql` 只写入系统必需的模型目录，不包含用户测试数据。任何 `service_role key` 或模型密钥
都不得提交到 Git。

## 二、Docker 一键部署（推荐）

### 2.1 新电脑准备

- 安装并启动 Docker Desktop，使用 Linux containers。
- 使用 Git 拉取仓库，或复制不含 `node_modules/` 和 `.next/` 的源码目录。
- 可访问 npm、Supabase 和所用模型提供商的网络。

确认 Docker 可用：

```powershell
git --version
docker version
docker compose version
```

取得代码：

```powershell
git clone <仓库地址> NeoCanvas
Set-Location NeoCanvas
```

### 2.2 一键启动

`deploy-docker.cmd` / `deploy-docker.ps1` 是 **Next.js 前端的一键部署入口**，会自动完成镜像构建、
容器启动和健康检查。它不会替你创建 Supabase 云项目，也不会自动持有数据库密码或服务角色密钥。

全新干净环境第一次部署时，请先完成第三至第八节的新 Supabase 初始化，再回到本节运行一键脚本。
后续只更新前端代码时，可以直接再次运行脚本。

Windows 下直接双击：

```text
deploy-docker.cmd
```

也可以在 PowerShell 运行：

```powershell
.\deploy-docker.ps1
```

首次运行会要求输入三个公开变量：

- `NEXT_PUBLIC_SUPABASE_URL`：例如 `https://abcdefgh.supabase.co`。
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`：Supabase publishable/anon key，不是 `service_role` key。
- `NEXT_PUBLIC_SITE_URL`：直接回车使用 `http://localhost:3100`。

脚本会把它们写入被 Git 忽略的 `.env.docker`，随后执行以下完整流程：

1. 验证 Docker Engine 与 Compose v2。
2. 使用多阶段 `Dockerfile` 构建 Next.js standalone 生产镜像。
3. 启动 `neocanvas-web` 服务并设置 `restart: unless-stopped`。
4. 最多等待 120 秒，直到 `/login` 健康检查通过。
5. 失败时输出最近 100 行容器日志；成功时显示访问地址和容器状态。

部署成功后打开 <http://localhost:3100>。

### 2.3 无交互 Compose 部署

服务器或自动化环境可先创建配置文件：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
NEXT_PUBLIC_SITE_URL=http://localhost:3100
NEOCANVAS_PORT=3100
```

保存为 `.env.docker`，然后执行：

```powershell
docker compose --env-file .env.docker up -d --build --remove-orphans
```

三个 `NEXT_PUBLIC_*` 变量会写入浏览器构建产物。修改 `.env.docker` 后必须重新运行部署命令，单纯
重启旧容器不会更新前端变量。

### 2.4 配置认证回调

在 Supabase 控制台的 **Authentication → URL Configuration** 中确认：

```text
Site URL: http://localhost:3100
Redirect URLs: http://localhost:3100/auth/callback
```

如果通过域名或局域网 IP 访问，`.env.docker`、Site URL 和 Redirect URLs 三处必须同时改成该地址。

### 2.5 日常运维

```powershell
# 状态与健康检查
docker compose --env-file .env.docker ps

# 实时日志
docker compose --env-file .env.docker logs -f web

# 拉取新代码并重建
git pull
.\deploy-docker.ps1

# 停止并删除前端容器（不会删除 Supabase 云端数据）
docker compose --env-file .env.docker down
```

全新环境必须先完成第三至第八节，再运行一键脚本。以后发布纯前端更新时，只需重新运行
`deploy-docker.ps1`；包含数据库迁移或 Edge Function 变更时，再执行对应后端章节。

## 三、创建并关联全新 Supabase 项目

1. 在 Supabase 控制台创建项目，保存以下信息：

   - Project ref。
   - Project URL。
   - Publishable/anon key。
   - `service_role` key。
   - 创建项目时设置的数据库密码。

2. 使用仓库锁定的 Supabase CLI 登录并关联项目：

```powershell
npx supabase login
npx supabase link --project-ref <project-ref>
```

项目 ref 是 URL `https://<project-ref>.supabase.co` 中间的那一段。不要把项目数据库密码或
`service_role key` 写进仓库。

## 四、应用数据库迁移与模型数据

仓库当前包含 `supabase/migrations/` 下的 **20 个迁移**。它们会依次建立扩展、枚举、表、索引、
RLS、函数与触发器、三个 Storage 桶、Realtime 发布、`pgmq` 队列、`pg_cron` 任务、BYOK 和媒体工作流。

先预览，再执行：

```powershell
npx supabase db push --dry-run
npx supabase db push --include-seed
```

第二条命令会在空项目中应用全部迁移，并执行 `supabase/seed.sql`。种子只初始化系统模型目录，不创建
用户、项目、画布节点或媒体对象，因此部署完成后业务系统保持干净。

部署后在 Supabase 的 SQL Editor 检查：

```sql
select count(*) as migration_count from supabase_migrations.schema_migrations;
select key, display_name, provider, modality, is_active
from public.model_catalog
order by sort_order, key;
select id, bucket_id, name from storage.buckets order by id;
select * from cron.job order by jobname;
```

应至少看到迁移 `20260101000001` 至 `20260101000020`、模型目录、`avatars` / `uploads` /
`generations` 三个桶，以及 NeoCanvas 的队列消费、轮询和清理定时任务。

## 五、配置数据库回调机密（Vault）

`pg_cron` 需要以服务角色调用队列消费和轮询函数。在 Supabase SQL Editor **首次部署时执行一次**：

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1',
  'edge_base_url'
);
select vault.create_secret('<service_role-key>', 'service_role_key');
select vault.create_secret('600000', 'generation_timeout_ms');
```

随后验证机密名称，不要查询或截图明文值：

```sql
select name, created_at, updated_at
from vault.secrets
where name in ('edge_base_url', 'service_role_key', 'generation_timeout_ms');
```

每个名称应只有一条。更换 key 时应更新现有 secret，不要用同名 `create_secret` 重复插入。

## 六、部署全部 Edge Functions

仓库当前有 **10 个**可部署函数：

```text
create-project
submit-generation
agent-orchestrate
process-generation-queue
poll-generations
generation-webhook
export-canvas
regenerate-poster
provider-credentials
swap-media-candidate
```

部署 `supabase/functions/` 下的全部函数；CLI 会读取 `supabase/config.toml` 中各函数的 JWT 设置：

```powershell
npx supabase functions deploy
```

不要统一添加 `--no-verify-jwt`。面向用户的函数必须验证 JWT；只有内部队列、轮询和外部回调函数按
`supabase/config.toml` 明确关闭网关 JWT 校验，并在函数内部执行服务角色或签名校验。

部署后检查：

```powershell
npx supabase functions list
```

## 七、配置 Edge Function secrets

### 7.1 最小可用配置

编排 LLM 必须有可用 key。默认可复用 `OPENAI_API_KEY`，也可以单独设置
`ORCHESTRATOR_LLM_API_KEY`。先生成 webhook 随机密钥：

```powershell
$webhookSecret = [Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLower()
```

使用 OpenAI 作为编排 LLM 的示例：

```powershell
npx supabase secrets set `
  OPENAI_API_KEY=<openai-key> `
  ORCHESTRATOR_LLM_MODEL=gpt-4o-mini `
  GENERATION_WEBHOOK_SECRET=$webhookSecret `
  MAX_INFLIGHT_GENERATIONS=8
```

### 7.2 按实际提供商追加

只设置实际使用的提供商：

```powershell
npx supabase secrets set GOOGLE_API_KEY=<google-key>
npx supabase secrets set ARK_API_KEY=<ark-key>
npx supabase secrets set FAL_API_KEY=<fal-key>
npx supabase secrets set REPLICATE_API_TOKEN=<replicate-token>
npx supabase secrets set SILICONFLOW_API_KEY=<siliconflow-key>
```

使用 SiliconFlow 兼容代理时才设置 `SILICONFLOW_BASE_URL`。使用独立编排端点时设置：

```powershell
npx supabase secrets set `
  ORCHESTRATOR_LLM_API_KEY=<llm-key> `
  ORCHESTRATOR_LLM_BASE_URL=<openai-compatible-base-url> `
  ORCHESTRATOR_LLM_MODEL=<model-id>
```

可选系统级参数：`MODERATION_API_KEY`、`CONTENT_BLOCKLIST`、`RATE_LIMIT_WINDOW_SECS`、
`RATE_LIMIT_MAX` 和 `MAX_INFLIGHT_GENERATIONS`。`SUPABASE_URL`、`SUPABASE_ANON_KEY`、
`SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 平台自动注入 Edge Functions，不要手动覆盖。

查看已配置的 secret 名称：

```powershell
npx supabase secrets list
```

### 7.3 BYOK 说明

登录用户可以在「设置 → 模型提供商」配置自己的 API Key。明文经 `provider-credentials` 函数写入
Vault，不会回流客户端。生成时的解析顺序是：

1. 用户启用的 BYOK 凭证。
2. Edge Function 环境中的系统级提供商 key。
3. 两者均不存在时返回 `model_unavailable`。

因此纯 BYOK 部署可以不设置各提供商的系统级 key，但编排 LLM 和内容审核仍是系统级配置。

## 八、配置认证

### 本机运行

在 Supabase 控制台 **Authentication → URL Configuration** 配置：

```text
Site URL: http://localhost:3100
Redirect URLs: http://localhost:3100/auth/callback
```

如果前端连接的是 Supabase CLI 本地地址（通常为 `http://127.0.0.1:54321`），认证邮件不会投递到
Gmail 等公网邮箱，而会被 Mailpit 捕获。登录页会自动读取本次本地邮件并完成验证，无需手动点击；
自动流程失败时才显示“打开本地收件箱”按钮，也可以直接访问 <http://localhost:54324>。该自动通道
仅在 Supabase URL 为 localhost / 127.0.0.1 时存在，托管环境无法调用。连接托管 Supabase 时会走其
邮件发送服务；正式环境应在 Supabase Auth 中配置自有 SMTP，避免默认邮件服务的限额影响登录。

Docker 连接本地 Supabase 时还需要区分浏览器与容器地址：浏览器使用
`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`，容器服务端使用
`SUPABASE_INTERNAL_URL=http://host.docker.internal:54321`。`deploy-docker.ps1` 会自动派生后者；手工运行
Compose 时需在 `.env.docker` 明确填写。托管 Supabase 不需要设置 `SUPABASE_INTERNAL_URL`。

### Google 登录

1. 在 Google Cloud Console 创建 Web OAuth 客户端。
2. Google 的 Authorized redirect URI 填：
   `https://<project-ref>.supabase.co/auth/v1/callback`。
3. 在 Supabase **Authentication → Providers → Google** 中填 Client ID 和 Client Secret。
4. 应用自己的回调地址仍是 `http://localhost:3100/auth/callback`，并保留在 Supabase Redirect URLs。

### 正式域名

若前端地址是 `https://canvas.example.com`，同时修改：

```dotenv
NEXT_PUBLIC_SITE_URL=https://canvas.example.com
```

并在 Supabase 中设置：

```text
Site URL: https://canvas.example.com
Redirect URLs: https://canvas.example.com/auth/callback
```

生产环境必须使用 HTTPS。

## 九、备用前端部署方式

以下方式不属于一键 Docker 部署。手工运行需要安装 Node.js 20+ 与 npm 10+，复制
`.env.example` 为 `.env.local`，并填写三个 `NEXT_PUBLIC_*` 公开变量。

### 开发模式

```powershell
npm run dev
```

访问 <http://localhost:3100>。代码修改后自动刷新。

### 本机生产模式

```powershell
npm run typecheck
npm run lint
npm run build
npm run start
```

访问 <http://localhost:3100>。每次修改代码或 `NEXT_PUBLIC_*` 变量后都必须重新执行
`npm run build`；这些公开变量会在构建时写入前端产物。

### Vercel

1. 将仓库导入 Vercel，Framework Preset 选择 Next.js。
2. Build Command 使用 `npm run build`，Install Command 使用 `npm ci`。
3. 在 Vercel 为目标环境设置：
   `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SITE_URL`。
4. 部署后把 Vercel 正式域名及 `/auth/callback` 加入 Supabase Auth URL Configuration。
5. Edge Function secrets 仍配置在 Supabase，不配置在 Vercel，也不放进 `.env.local`。

建议 dev / staging / prod 各使用独立 Supabase 项目和独立前端部署。

## 十、上线验收清单

按顺序检查，失败时先停在当前步骤排查：

1. `docker compose --env-file .env.docker ps` 显示 `web` 为 `healthy`。
2. 打开 `/login`，邮箱登录或 Google 登录后能回到 `http://localhost:3100/auth/callback` 并完成会话。
3. 首页能加载模型列表和最近项目，无 RLS 或环境变量错误。
4. 输入想法并发送后能创建项目，地址进入 `/p/<projectId>`。
5. 生成占位节点出现，任务从 `pending` 进入 `running`，最后成为 `succeeded` 或给出明确错误。
6. 图片或视频结果写入 `generations` Storage，并通过 Realtime 出现在画布。
7. 上传附件后能读取签名 URL；画布节点移动后刷新页面仍保留位置。
8. 返回首页能看到项目缩略图和更新时间。

Supabase 控制台重点查看：

- **Edge Functions → Logs**：函数异常、提供商响应和缺失 secret。
- **Database → Logs / Table Editor**：迁移、RLS、`generations` 状态。
- **Storage**：桶和对象是否写入。
- **Realtime**：项目频道是否正常连接。

## 十一、常见故障

| 现象                              | 优先检查                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| 页面提示缺少 Supabase 变量        | Docker 检查 `.env.docker`；手工 Node 模式检查 `.env.local`；修改后重新构建         |
| 新环境出现旧账号或旧项目          | 仍连接了旧 Supabase URL；新建空项目、更新 `.env.docker` 后重新构建                 |
| 登录后回到错误端口或被拒绝        | `.env.docker` 的站点地址、Supabase Site URL 和 Redirect URLs 是否完全一致          |
| Google 报 `redirect_uri_mismatch` | Google 控制台是否填写 Supabase 的 `/auth/v1/callback`，不是应用的 `/auth/callback` |
| 建项目时报 401                    | 登录会话是否有效；面向用户的 Edge Function 是否错误使用了 `--no-verify-jwt` 配置   |
| 生成一直 `pending`                | `process-generation-queue` 是否部署；Vault 两个回调 secret 和 `cron.job` 是否存在  |
| 生成一直 `running`                | `poll-generations` 日志、提供商 key、网络和 `generation_timeout_ms`                |
| `model_unavailable`               | 用户 BYOK 是否启用，或相应 `*_API_KEY` 是否存在于 Supabase secrets                 |
| 上传失败                          | `uploads` / `generations` 桶、Storage policy、文件大小与 MIME 类型                 |
| Realtime 不更新                   | `supabase_realtime` publication 和浏览器连接日志                                   |
| `db push` 扩展失败                | 确认目标是 Supabase 托管项目并启用了 `pg_cron`、`pg_net`、`pgmq`、Vault            |
| Docker 构建提示缺少变量           | `.env.docker` 是否存在且三个 `NEXT_PUBLIC_*` 均已填写                              |
| 容器启动后为 `unhealthy`          | 执行 `docker compose --env-file .env.docker logs --tail 100 web`                   |
| 修改配置但页面仍是旧值            | `NEXT_PUBLIC_*` 是构建时变量，重新运行 `deploy-docker.ps1` 构建镜像                |

## 十二、第二天现场部署建议顺序

1. 提前确认仓库代码、Supabase 登录账号、数据库密码和模型密钥可用。
2. 在 Supabase 控制台新建空项目，不复用当前测试项目。
3. 按第三至第七节关联项目、应用迁移与种子、配置 Vault、部署函数并设置 secrets。
4. 按第八节配置新项目的 Auth URL、SMTP 和需要的 OAuth 提供商。
5. 新电脑安装并启动 Docker Desktop，拉取仓库后双击 `deploy-docker.cmd`。
6. 一键脚本中填写新 Supabase 项目的 URL 和 anon key，等待容器显示 `healthy`。
7. 使用全新账号完成登录、建项目、上传和生成验收，确认首页没有任何旧测试项目。

整个过程只复用代码和声明式结构，不复制数据库记录、Auth 用户、Storage 对象或 Docker 卷，目标环境
因此从零开始且数据完全干净。
