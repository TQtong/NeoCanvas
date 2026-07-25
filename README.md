# NeoCanvas

> 对话驱动 + 无限画布的 AI 设计代理（AI Design Agent）。让设计更简单。

NeoCanvas 让用户用自然语言指挥多模态生成模型，在一块可无限平移、缩放的画布上完成图像、
视频与图文内容的创作、编排与迭代。主页输入想法 + 选模型即建项目进入设计页；设计页左侧是
承载一切视觉元素的无限画布，右侧是与智能体对话的面板。

## 技术栈

| 层   | 选型                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| 前端 | Next.js 15 App Router · React 19 · TypeScript 严格模式                                  |
| 画布 | `@xyflow/react`（React Flow v12）—— 每个元素是一个自定义节点                            |
| 状态 | Zustand（画布 / 对话 / 会话 三库）                                                      |
| 后端 | Supabase（PostgreSQL · Auth · Storage · Realtime · Edge Functions · pgmq · pg_cron）    |
| AI   | 模型适配器抽象：OpenAI · Google · 火山方舟 Ark · SiliconFlow，并支持 fal.ai / Replicate |
| 样式 | Tailwind CSS（磨砂玻璃 + 克制紫色强调）                                                 |

## 快速开始

新电脑部署采用干净环境：先新建空 Supabase 项目，按部署指南应用迁移、种子并部署 Edge Functions，
再运行前端一键脚本。当前测试环境的项目、用户、Storage 对象和 Docker 卷都不会迁移。

```powershell
# Windows 双击 deploy-docker.cmd，或运行：
.\deploy-docker.ps1
```

首次运行输入 Supabase URL、publishable/anon key 和站点地址；脚本会自动构建容器、启动服务并等待
健康检查通过。该脚本负责前端容器，新 Supabase 的首次初始化步骤见
[Docker 部署指南](docs/SETUP.md)。部署完成后访问 <http://localhost:3100>。

完整后端落地（迁移 / 存储 / 队列 / 定时任务 / Edge Functions 部署）见
[docs/SETUP.md](docs/SETUP.md)。

## 文档

- 设计文档：[`docs/00`](docs/00-项目总览与文档导航.md) … [`docs/06`](docs/06-接口与契约设计.md)
- 部署指南：[`docs/SETUP.md`](docs/SETUP.md)
- 工程总纲：[`CLAUDE.md`](CLAUDE.md)

## 工程脚本

```bash
npm run docker:up   # 使用 .env.docker 一键构建并启动
npm run docker:logs # 查看容器日志
npm run docker:down # 停止容器
npm run dev         # 本地开发（http://localhost:3100）
npm run build       # 生产构建
npm run start       # 生产运行（http://localhost:3100）
npm run typecheck   # 类型检查（CI 必过）
npm run lint        # ESLint
npm run format      # Prettier
```

Edge Functions 为 Deno，独立于 Next 构建：`npx deno check supabase/functions/*/index.ts`。

## 目录结构

```
app/          路由：主页、设计页(/p/[projectId])、登录、auth/callback、middleware、server actions
components/   canvas（画布 + 7 类节点 + 变换/工具栏/控件） · chat · home · ui · shared · auth
stores/       canvas-store · chat-store · session-store
lib/          supabase 客户端 · canvas 几何/映射 · realtime · storage · edge · hooks · data 加载
types/        贯穿前后端的共享类型契约（枚举 / 节点判别联合 / 生成请求 / 响应封套 …）
i18n/         中英文案
supabase/     migrations（枚举/表/索引/RLS/触发器/storage/realtime/队列/cron）· functions（Deno）· seed.sql
docs/         七份设计文档 + 部署指南
Dockerfile · compose.yaml · deploy-docker.cmd/ps1   Docker 一键部署入口
```

## 实现纪律

全量 TypeScript 严格模式，**无简化实现 / 占位符 / TODO**；公共 API 具完整 JSDoc，关键
注释用中文；前端 `tsc` 与 Edge Functions `deno check` 均零错误，生产构建通过。
