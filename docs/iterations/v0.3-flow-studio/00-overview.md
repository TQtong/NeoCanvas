# NeoCanvas v0.3.0 — Flow Studio 总览

> 状态：工程候选完成。自动化门禁已经通过；受控 staging 的真实图片、编辑与视频 Provider
> 冒烟尚未执行。在该发布门禁通过前，根目录 `docs/00–06` 与包版本仍保持已发布的 v0.2.0
> 真相，Flow Studio 前端与 Edge 开关默认关闭。

## 目标与用户

Flow Studio 面向需要稳定复现多步骤媒体创作流程的专业设计师。它在同一项目内增加 Flow
执行视图，与现有 Canvas 内容视图共享项目、资产、对话、模型目录和生成账本，但不把内容节点
混作执行节点。

核心价值是“看得见、能复跑、可调试、可复用”：模型调用必须由用户显式触发，修改只让下游过期，
不产生隐式费用。

## 核心场景

- FS-SC-01：文本 → 四张候选图 → 人工选择 → 放大 → 发布到 Canvas。
- FS-SC-02：图片 + 蒙版 + Prompt → 局部重绘 → 图片输出。
- FS-SC-03：关键帧集合 → 序列视频 → 视频输出。
- FS-SC-04：把成熟流程发布为个人模板和项目内 Flow App。
- FS-SC-05：Flow Agent 提出图差异，设计师确认后应用，再手动运行。

## 产品参考结论

参考 Firefly Boards 的画布语境、Freepik Spaces 的节点运行和模板、Krea Node Agent 的图级
编排、Figma Buzz 的受控批量输入，以及 Lovart 的对话式设计代理。NeoCanvas v0.3 选择专业媒体
管线与显式执行，不引入条件、循环、代码、HTTP 或自动响应式运行。

## 功能地图

| 能力                 | 需求 ID  | 设计来源                     |
| -------------------- | -------- | ---------------------------- |
| Canvas / Flow 双视图 | FS-PR-01 | `01-product-requirements.md` |
| 强类型 DAG 编辑      | FS-PR-02 | `04-frontend-design.md`      |
| 修订、增量运行与缓存 | FS-EX-01 | `05-agent-and-execution.md`  |
| 精确模型绑定         | FS-EX-04 | `05-agent-and-execution.md`  |
| 个人模板与 Flow App  | FS-PR-06 | `01-product-requirements.md` |
| Agent 差异确认       | FS-AG-01 | `05-agent-and-execution.md`  |

## 里程碑

1. 第 1–2 周：文档、契约、迁移、RLS、注册表和双视图壳层。
2. 第 3–5 周：不可变修订、DAG 计划、缓存、队列和 `workflow_output`。
3. 第 5–7 周：输入、集合、选择、图片编辑与视频节点。
4. 第 7–9 周：历史、等待/恢复、重试/取消、下载与发布 Canvas。
5. 第 9–10 周：个人模板与 Flow App。
6. 第 10–11 周：Flow Agent 提案与确认。
7. 第 11–12 周：真实 Provider 冒烟、性能、安全、E2E 与灰度。

## 发布门禁

- 客户端与 Edge 同时受 `FLOW_STUDIO_ENABLED` 控制，默认关闭。
- 数据库迁移只能增量添加；关闭入口和工作流消费者即可回滚流量。
- 所有自动化检查和五条核心 E2E 通过，且至少一个图片、编辑、视频真实模型冒烟通过。
- 500 节点图首个可交互时间不超过 2 秒；客户端图校验 P95 不超过 100ms。

## 明确非目标

多人协作、评论、团队模板、公开 App、市场、条件/循环/Map、代码/HTTP/MCP 节点、自动执行、
外部发布、计费、音频、3D、Canvas 完整版本史及公开评审均不属于 v0.3。

## 术语

- Workflow：项目内可编辑的当前图。
- Revision：一次运行固定的不可变图快照。
- Run / Run Node：一次执行及其中每个节点的状态。
- Template：个人拥有的不可变版本图。
- Flow App：固定到模板版本、仅暴露白名单字段的简化运行表单。
- Publish to Canvas：把 Flow 输出显式创建为普通 Canvas 内容节点。
