# Flow Studio 数据模型

## 编辑态

- `workflows`：项目、所有者、名称、描述、`graph_revision`、viewport。
- `workflow_nodes`：kind、flow 坐标、config、schema version；一节点一行。
- `workflow_edges`：显式 source/target port 与 `FlowValueType`。

节点或边 INSERT/UPDATE/DELETE 后触发器锁定 workflow 并递增 revision。RLS 通过项目所有者校验。

## 不可变修订

- `workflow_revisions`：workflow、revision number、graph hash、创建者。
- `workflow_revision_nodes` / `workflow_revision_edges`：运行时快照。
- `workflow_revision_asset_refs`：快照引用的固定资产，用于删除保护与可追溯性。

同一 workflow + revision number 唯一。创建后客户端与 authenticated 均无 UPDATE/DELETE 权限。

## 运行账本

- `workflow_runs`：revision、模式、目标、force、幂等键/请求哈希、状态和时间。
- `workflow_run_nodes`：节点配置快照、状态、cache key/source、模型/provider/executor 快照、错误。
- `workflow_run_outputs`：端口、强类型值、资产、顺序与发布 Canvas 节点。
- `workflow_run_input_links`：运行节点输入到上游 output 的解析血缘。

`generations` 增加 nullable `workflow_run_node_id`，`result_mode` 增加 `workflow_output`。普通 Canvas
生成必须没有 run node；Flow 生成必须有 run node 且没有 placeholder。

## 复用与 Agent

- `workflow_templates` / `workflow_template_versions`：个人模板及不可变图版本。
- `flow_apps` / `flow_app_versions`：项目内 App、固定 template version、字段和输出绑定。
- `workflow_patch_proposals`：base revision、instruction、Patch、过期时间和决议状态。

## 索引与清理

- 编辑图按 workflow 索引；边对 source/target 建索引。
- Runs 按 workflow + created_at，run nodes 按 run + status，outputs 按 run node + port + ordinal。
- 幂等唯一键为 requester + workflow + idempotency key。
- 缓存查询索引为 workflow + cache key + succeeded/cached。
- proposal 过期后只改变状态，不删除审计记录。
- 删除 workflow 级联编辑图、修订和运行账本；已登记 assets 仍由项目资产生命周期管理。
