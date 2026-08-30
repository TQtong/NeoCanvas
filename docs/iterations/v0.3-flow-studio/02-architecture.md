# Flow Studio 架构设计

## 总体结构

Flow 前端使用实例级 Zustand Store，避免多个工作流或项目共享全局图状态。PostgreSQL 是唯一
真相；客户端采用乐观更新、300ms 防抖写入、IndexedDB Outbox、Realtime 回流校正与 revision
冲突检测。

公开能力面包含 `workflow-execute`、`workflow-agent`、`workflow-publish`。内部
`process-workflow-queue` 只接受 service role，负责纯节点执行、缓存命中和生成任务提交。

## FS-AR-01 数据流

1. 客户端保存当前 `workflow_nodes` / `workflow_edges`，触发器递增 `graph_revision`。
2. `start` 校验 expected revision、端口与 DAG，事务捕获不可变 revision 和 run plan。
3. 消费者原子 claim ready 节点；纯节点直接完成，人工节点暂停，媒体节点提交 generation。
4. generation 继续使用既有 Provider adapter、审核、staging、Webhook/Poller 和 exactly-once 终态。
5. `workflow_output` 通过专用事务写入资产与 `workflow_run_outputs`，不创建 Canvas 节点。
6. 完成事件再次唤醒工作流消费者，直到成功、部分失败、失败、等待或取消。

## FS-AR-02 修订与并发

Run 引用不可变 `workflow_revisions`。revision snapshot 包含节点、边及固定资产引用。`start` 使用
expected graph revision 和幂等键；同键同哈希返回已有 Run，同键异哈希返回冲突。claim、完成、
发布均使用条件更新或行锁，避免多消费者重复执行。

## FS-AR-03 缓存

缓存键由 workflow、node kind、schema/executor version、规范化配置、解析输入签名、model key 与
resolved provider model 组成。缓存只在同一 Workflow 内复用，且使用前确认所有资产仍存在。
强制重跑绕过目标及下游缓存。

## FS-AR-04 Realtime

工作流频道为 `workflow:{workflowId}`，订阅 workflows、nodes、edges、runs、run nodes 和 outputs。
广播不得携带凭据、供应商原始响应、签名 URL、敏感 Prompt。资产 URL继续通过现有签名服务按需解析。

## FS-AR-05 安全与恢复

- 全部业务表启用 RLS；所有权经 workflow → project → owner 关联验证。
- service role 只存在 Edge，内部消费者额外校验服务角色 JWT。
- Agent 输出视为不可信输入；apply 前重新校验 Schema、端口、DAG、revision 和权限。
- staging 失败沿用补偿账本；取消后迟到生成结果被终态门禁丢弃。
- 功能关闭时不启动新 Run；已有数据库对象保持可恢复，不执行破坏性回滚。
