# Flow Studio 前端设计

## FS-FE-01 页面与状态

项目页读取 `view` 与 `workflow` 查询参数。Flow 开关关闭时忽略 `view=flow` 并保持 Canvas。
`WorkflowProvider` 为每个挂载的工作流创建 Zustand vanilla store；不得增加跨项目全局 Flow Store。

## FS-FE-02 三栏界面

- 左栏：工作流选择、新建、可搜索节点库，按输入/组织/图片/视频/输出/辅助分组。
- 中栏：React Flow DAG、缩放/定位、节点运行状态、校验问题和运行工具栏。
- 右栏：Config、Run、Agent 三个页签；窄屏时折叠为抽屉。

节点卡显示标题、模型、状态和强类型端口。连接前实时校验类型、基数与环路；连接失败不写数据库。

## FS-FE-03 配置

检查器按注册表渲染受控字段，不提供任意 JSON 编辑器。模型节点只列出当前用户可访问且 modality
匹配的精确 model key。改变配置后当前节点及下游显示 stale，但不会调用 Edge。

## FS-FE-04 持久化与 Realtime

拖动与配置先乐观更新，300ms 后按节点/边增量 UPSERT。失败写入 IndexedDB Outbox；在线后按
workflow 顺序重放。Realtime 以记录 ID 校正，忽略本地回声；graph revision 不一致时停止覆盖并提示。

## FS-FE-05 运行与结果

Run 页签提供运行节点/下游/全部、force、取消、失败重试、历史列表和 output 预览。manual select
展示候选资产，选择后调用 resume。输出支持下载和发布 Canvas。

## FS-FE-06 模板、App 与 Agent

模板发布要求名称；Flow App 只允许选择注册表中的 `appExposablePaths`，并设置标签、默认值和顺序。
Agent 页签显示 instruction、Patch 摘要和逐项差异；apply/reject 都是显式按钮。

## 性能

- 500 节点只渲染视口及邻近节点，检查器选择器避免订阅整图。
- 结构校验以纯数据执行；超过 100 节点转 Web Worker，并用 graph revision 丢弃过期结果。
- 拖动期间不发请求；结束后只持久化改变节点。
- 模型目录和凭据沿用 Workbench Provider，每个工作台最多各请求一次。
