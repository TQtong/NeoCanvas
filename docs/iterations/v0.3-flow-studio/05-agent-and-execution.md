# Flow Agent 与执行语义

## FS-EX-01 节点注册表

每项定义 kind、schema version、分类、输入/输出端口及基数、Zod 配置、App 可暴露路径、executor
version、缓存策略和模型能力。端口仅允许共享契约中的八种 `FlowValueType`，禁止隐式转换。

## FS-EX-02 计划与失效

启动前检查引用、端口、类型、单输入基数、必需输入、配置和环路。`node` 只计划目标及必需上游；
`downstream` 计划目标与全部下游，并解析必需上游；`all` 使用全图稳定拓扑序。修改节点只标记它与
下游 stale。

## FS-EX-03 状态传播

- pure/input/output 成功后立刻解锁下游。
- media node 提交 generation 后为 waiting_generation。
- manual select 为 waiting_user，resume 固定所选 output 后继续。
- 上游失败使无法运行的下游 skipped；其余独立分支继续，最终为 partial。
- retry 重置目标和下游失败/跳过节点，不删除已成功输出。
- cancel 把非终态节点和 generation 标记 cancelled；迟到回调不能复活运行。

## FS-EX-04 模型与缓存

模型节点必须固定 `modelKey`。启动时解析并记录 provider 与 provider model；不可用即阻断，不
fallback。缓存键包含 workflow、节点/执行器版本、规范配置、输入签名和模型解析，使用前验证资产。

## FS-AG-01 Agent 权限

Agent 只允许六种操作：add/update/move/remove node、add/remove edge。`propose` 固定 base revision
并保存最多 30 分钟。`apply` 在事务中锁定 workflow，revision 不符即 conflict；应用临时图后完成
同一套注册表与 DAG 校验才写入。历史、Run、Output、Asset 不属于 Patch 目标。

## Prompt 模板

变量语法为 `{{name}}`。执行时按进入 `variables` 端口的稳定边顺序填充；缺少变量保持校验错误，
不把未替换模板发送给 Provider。模板值与敏感输入不写入 Realtime 广播或普通日志。
