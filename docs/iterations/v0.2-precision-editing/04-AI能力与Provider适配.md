# v0.2.0 AI 能力与 Provider 适配

## 一、目标

把图片编辑从「把参考图尽量传给模型」升级为可验证的操作级能力。前端、生成流水线与适配器对同一模型必须得到一致结论；任何 Provider 都不得通过忽略蒙版、改写操作或猜测字段完成表面成功。

## 二、能力判定

每个图片适配器声明不可由运行时配置扩大的 `supportedOperations`。`model_catalog.capabilities.imageOperations` 声明某个模型实际开放的操作，用户凭据决定该 Provider 实例当前是否可调用。最终能力严格取三者交集：

```text
availableOperations = adapter.supportedOperations
                    ∩ model.capabilities.imageOperations
                    ∩ credential.availableOperations
```

凭据通常继承适配器操作集合；自定义 Provider 可以进一步收窄，但不能扩大。客户端过滤和服务端提交校验使用同一共享函数。客户端结果仅用于展示，Edge Function 在调用外部 API 前必须重新读取模型目录、解析自定义 Provider 协议并验证交集。

模型目录的默认回填规则为：现有图片生成模型只有在当前适配器已经实现对应构造器且官方接口明确支持时才加入编辑操作；无法确认的模型只保留 `generate`。工具型模型可以没有 `generate`，此时只在图片编辑器出现。

## 三、统一 Provider 矩阵

| Provider        | v0.2.0 开放操作                                                                    | 约束与依据                                                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI          | `generate`、`semantic_edit`、`inpaint`、`outpaint`                                 | 图片编辑接口区分输入图片与单独蒙版，并支持输入保真度；实现以 [GPT Image 模型文档](https://developers.openai.com/api/docs/models/gpt-image-1.5)和正式 API Schema 为准                                                                                                                                                                |
| Google Gemini   | `generate`、`semantic_edit`                                                        | 支持图片输入和通过提示词增加、删除、修改元素；不把语义遮罩描述成精确像素蒙版，依据 [Gemini 图片生成文档](https://ai.google.dev/gemini-api/docs/image-generation)                                                                                                                                                                    |
| Volcengine Ark  | `generate`、`semantic_edit`                                                        | 普通生成使用 Ark ImageGenerations，编辑只对目录中明确的 SeedEdit 模型开放，依据 [Ark API](https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01)                                                                                                                                      |
| Jimeng          | `generate`、`semantic_edit`、`inpaint`、`outpaint`、`remove_background`、`upscale` | 每类编辑使用火山视觉服务文档定义的专用 action；交互式重绘依据[即梦局部重绘文档](https://www.volcengine.com/docs/85621/1976207?lang=zh)，其他操作按已启用 action 分别建目录项                                                                                                                                                        |
| MiniMax         | `generate`、受限的 `semantic_edit`                                                 | 参考图仅表示人物主体一致性，不开放为通用图片编辑、重绘或扩图，依据 [MiniMax Image-to-Image](https://platform.minimax.io/docs/api-reference/image-generation-i2i)                                                                                                                                                                    |
| SiliconFlow     | `generate`、已验证模型的 `semantic_edit`                                           | Qwen Image Edit 等目录项可开放语义编辑；没有正式蒙版 Schema 的模型不得声明 `inpaint`                                                                                                                                                                                                                                                |
| fal.ai          | `inpaint`、`remove_background`、`upscale`，以及具体目录模型明确支持的其他操作      | 重绘使用 `image_url` 与 `mask_url`；去背景与 Topaz 2×/4× 放大使用独立工具接口，依据 [Inpaint](https://fal.ai/models/fal-ai/inpaint/api)、[Remove Background](https://fal.ai/docs/model-api-reference/image-generation-api/imageutils)和 [Topaz Upscale](https://fal.ai/docs/model-api-reference/image-generation-api/topaz-upscale) |
| Replicate       | 受控 Profile 声明的 `inpaint`、`remove_background`、`upscale`                      | 不对任意模型猜测输入输出；放大 Profile 依据 [Real-ESRGAN 指南](https://replicate.com/docs/guides/upscaling-images/real-esrgan)                                                                                                                                                                                                      |
| 自定义 Provider | 所选内置协议能力与模型声明的交集                                                   | 自定义 endpoint、凭据和模型名不构成新协议能力；未实现的操作在保存配置和提交时都被拒绝                                                                                                                                                                                                                                               |

「覆盖全部 Provider」表示所有 Provider 都进入统一能力发现和校验，不表示每个 Provider 必须支持五种编辑。界面不会显示空洞占位模型，也不会把某操作自动转交给用户未选择的 Provider。

## 四、适配器职责

基础适配器增加以下职责：

- 暴露只读 `supportedOperations`。
- 按 operation 验证输入数量、引用角色、尺寸、输出数量和专属参数。
- 生成操作专用请求，不能先构造通用请求再丢弃不认识的字段。
- 把同步和异步结果统一归一为带 MIME、宽高、字节数与临时性标记的 `AssetCandidate`。
- 校验透明输出、实际候选数量、媒体可下载性和结果尺寸。
- 把 Provider 错误映射到现有统一错误码，同时在 `details` 中保留安全的 Provider 请求 ID、阶段和原因。

流水线在进入适配器前完成项目、模型、凭据、能力和输入所有权校验；适配器仍须执行操作级参数校验，形成纵深保护。

## 五、Provider 请求规则

### OpenAI

- `generate` 使用图片生成请求，不携带编辑输入。
- `semantic_edit` 把所有 `content`/`style` 引用作为输入图片数组，按顺序上传。
- `inpaint` 恰好一个 `content` 输入和一个 `mask`，蒙版使用专用 `mask` 字段，禁止把蒙版混入普通图片数组。
- `outpaint` 先由服务端或受信客户端构造与目标画布同尺寸的透明输入和蒙版，再调用编辑接口；输入布局必须与 `outputCanvas` 一致。
- 仅在模型能力声明时发送 `input_fidelity` 和透明背景参数。

### Google Gemini

- `semantic_edit` 将提示词与内容图片按顺序组成同一用户消息。
- 不消费 `mask` 引用，不声明 `inpaint`；即使提示词含「只修改选区」，也仍属于语义编辑。
- 输出中没有有效图片 Part 时以 Provider 结果无效处理，不把文本说明当作成功图片。

### Volcengine Ark 与 Jimeng

- Ark 生成与 SeedEdit 使用各自已验证的模型目录配置，不根据模型名字符串猜测能力。
- Jimeng 为生成、局部重绘、扩图、去背景和放大分别实现 action Profile；Profile 包含 endpoint action、版本、签名服务名、输入字段映射和结果提取路径。
- 用户凭据未获某 action 权限时，仅禁用该 action 对应操作；不能因此把整个 Jimeng Provider 标记为不可用。

### MiniMax

- `semantic_edit` 的 `content` 输入映射为 `subject_reference`，并明确 `type = 'character'`。
- 非人物主体或需要几何精确保持的通用编辑不使用 MiniMax。
- 收到 `mask`、`outputCanvas` 或 `upscaleFactor` 时立即以 `unsupported_param` 拒绝。

### SiliconFlow

- 普通生成模型只开放 `generate`。
- 编辑目录项必须绑定已验证的图片编辑 endpoint 和输入字段；当前没有蒙版契约时只开放 `semantic_edit`。
- 自定义 SiliconFlow 兼容 endpoint 继承同一限制。

### fal.ai

- Inpaint Profile 将 `content` 映射为 `image_url`、`mask` 映射为 `mask_url`，并保持白色编辑、黑色保留语义。
- Remove Background Profile 固定输出透明图片并验证 Alpha 通道。
- Topaz Profile 只接受能力声明中的 2×/4×，结果自然宽高必须接近输入对应倍数，否则标记无效。
- 每个工具作为独立模型目录项，不能用一个通用 fal 模型条目宣称全部工具。

### Replicate

- 只支持仓库内显式登记的 Profile；每个 Profile 固定模型版本、operation、输入键、枚举映射和输出解析。
- 模型版本更新必须新增或更新 Profile 并通过契约测试，不在运行时根据返回 JSON 猜测。
- URL、数组、对象等不同输出形状统一归一后再进入结果落地。

## 六、内容安全、超时与日志

- 编辑提示词和输入图片沿用既有内容安全边界；Provider 拒绝映射为 `content_blocked`，不保存原始敏感响应正文。
- 同步操作使用适配器配置的请求超时；异步操作继续通过轮询和 Webhook 完成，终态超时映射为 `generation_timeout`。
- 结构化日志固定包含 `generation_id`、`operation`、`provider`、`model_key`、`input_count`、输入/输出像素、候选数、阶段、耗时、结果状态和统一错误码。
- API key、签名密钥、完整图片 URL、提示词全文和蒙版内容不得进入日志。

## 七、失败处理

- 能力交集不包含请求操作：返回 `unsupported_param`，`details.reason = 'unsupported_image_operation'`。
- Provider 凭据不可用或无 action 权限：返回 `model_not_accessible`，界面引导检查配置。
- Provider 临时不可用、响应无法解析或媒体下载失败：返回 `provider_error`，保留 generation 和输入供重试。
- Provider 返回少于请求候选数时，落地有效候选并在 generation 元数据记录短缺；返回零个有效候选时任务失败。
- Provider 返回多于请求数量时只消费前 N 个，额外远程结果不落入项目。
- 任何蒙版操作都不得降级为语义编辑；任何透明输出失败都不得用白底图片冒充去背景成功。

## 八、验收

- 每个适配器对矩阵中的开放操作具有正向契约测试，对未开放操作具有拒绝测试。
- 客户端过滤、Edge 能力校验和适配器声明对同一模型返回相同操作集合。
- OpenAI 测试证明蒙版与输入图片字段分离；Google、MiniMax、SiliconFlow 测试证明不会宣称精确蒙版。
- Jimeng、fal.ai 和 Replicate 的每个工具 Profile 都有固定请求快照和响应归一化测试。
- 自定义 Provider 无法通过伪造模型能力绕过适配器上限。
- 日志不包含凭据、签名 URL、提示词全文或图片内容。
