# Flow Studio API、契约与测试

## 公共 Edge API

### `workflow-execute`

请求 `WorkflowExecuteRequest`，action 为 start、resume、retry、cancel、publish_output。start 必须带
project/workflow、expected graph revision、run mode 和幂等键；响应为 run、revision、状态及去重标记。

### `workflow-agent`

propose 需要 instruction 与 base revision；apply/reject 需要 proposal ID。响应始终返回 proposal
状态、Patch 和当前 graph revision。

### `workflow-publish`

publish_template 创建不可变模板版本；instantiate_template 在目标项目创建新 Workflow 并重映射
UUID；publish_app 校验 fields/outputs 后固定 template version。

## 内部 API 与事务

- `process-workflow-queue`：service role 唯一入口，claim ready 节点并推进 Run。
- `create_workflow_run`：revision 捕获、run plan、input links 和幂等写入单事务。
- `create_workflow_generation_submission`：生成、输入血缘、队列写入单事务，无 Canvas placeholder。
- `land_workflow_generation_result_once`：资产、outputs、generation/run node 终态单事务。
- `apply_workflow_patch`：revision 锁、Patch 和 graph revision 单事务。
- `publish_workflow_outputs`：输出到 Canvas 幂等单事务。

所有接口使用统一 `ApiResponse<T>` 和既有稳定错误码；revision/幂等冲突使用 `conflict` 或
`idempotency_conflict`。

## 测试矩阵

- 单元：端口类型、变量、必需/重复输入、环路、拓扑、下游、配置 Schema、500/1000 规模。
- 执行：缓存零 Provider 调用、force 范围、等待/恢复、失败/partial、retry/cancel。
- 并发：重复 start、queue/Webhook/Poller 竞争、output/publish exactly-once。
- 模型：模型停用、凭据丢失、provider model 漂移，全部无 fallback。
- 复用：模板 UUID 重映射、版本固定、App 字段白名单和旧版本执行。
- Agent：拒绝、应用、过期、revision 冲突、越权和恶意 Patch。
- 同步：多标签页、Outbox、断线重连、Realtime 回声抑制。
- 安全：RLS、内部鉴权、日志/广播敏感信息、孤儿 staging 清理。

## E2E

1. Text → Image Generate(4) → Manual Select → Upscale → Image Output → Publish Canvas。
2. Image + Mask + Prompt → Inpaint → Image Output。
3. Image Collection → Sequence Video → Video Output。
4. Publish Template → Flow App → Form Run → Bound Outputs。
5. Agent Propose → Diff → Apply → Manual Run。

## 交付门禁

`contracts:check`、format、lint、typecheck、Vitest、Deno check/test、数据库测试、集成测试、build、
Playwright 全部通过；真实图片生成、精确编辑和视频 Provider 各至少一条冒烟成功。

## 当前工程验证状态

2026-08-30 已完成本地工程候选验证：共享契约漂移、Prettier、ESLint、TypeScript、生产构建、
前端/Edge/数据库/并发集成测试全部通过；Playwright 以单 worker 执行 14 条用例全部通过。
Flow 专项覆盖纯文本不可变运行、显式输出与 Canvas 幂等发布、个人模板、Flow App UUID 重映射、
Agent 提案确认与不自动运行，以及四图生成、人工选择、2× 放大、缓存复用和无 Canvas 占位节点。
500 节点/1000 边客户端校验与服务端计划均纳入 100ms 门禁。

真实 Provider 冒烟仍必须在受控 staging 使用专用低额度凭据执行，不能用开发机凭据或确定性
测试 Provider 代替。该门禁未完成前不修改根目录 `docs/00–06`、`package.json` 版本号，也不打开
生产 `FLOW_STUDIO_ENABLED` 开关。
