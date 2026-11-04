# 模型接口分支规格

| 项目 | 约定 |
| --- | --- |
| 版本与日期 | v1.4，2026-11-04 |
| 分支与工作区 | `codex/intent-api`，`3DCar-intent-api` |
| 需求依据 | 需求 v1.8 的 §4.4、§5、A13–A23，架构 v1.7 的 §4、§5 |
| 公共契约 | `shared/control.ts` 与兼容的 `shared/intent.ts` |
| 本分支路径 | `server/**` |
| 运行方式 | Cloudflare Worker 接受 HTTPS 请求，单个 Durable Object 原子预留调用额度 |

## 1. 行为与职责

页面完成唤醒后，完整规则直接执行。未匹配或低置信度片段携带当前工具定义、状态和对话提交到模型。模型澄清缺失信息，明确意图后通过 Function Calling 产生调用，内置车辆工具经页面校验后直接执行，不统一追加固定用词确认。

带 `tools` 和 `context` 的请求使用工具调用契约。工具最多 16 个，Schema 支持对象参数、字符串枚举、数值范围和布尔值，请求体上限 32 KiB。模型输出上限 512 tokens，一次最多 8 个调用。后端与浏览器分别验证函数和参数。

服务端适配通过 Bearer Key 鉴权、使用 `messages` 输入和 `choices[0].message.content` 输出的 Chat Completions 兼容接口。完整 HTTPS 地址、模型标识和 Key 从运行环境读取。发布时按所选服务商验证兼容性和真实中文意图效果。

## 2. HTTP 契约

- 连续对话可带 `dialogue`：最多 12 条完整交替的 user/assistant 消息，每条非空且最多 1000 字符，合计最多 6000 字符。服务端拒绝 system 等角色、畸形、顺序错误及超量历史；将有效历史放在当前请求之前。结合当前工具状态理解短答和相对调整，信息不足时继续澄清。
- `GET /api/speech` 提供中文 ASR WebSocket 代理，契约见 `shared/speech.ts`。限制 Origin、配额、帧大小、音频速率和 120 秒会话上限。服务端保存 Key 并固定识别配置。语音与模型使用不同配额桶，部署示例每客户端每分钟 20 次、各全站每日 100 次。

- 路径为 `POST /api/intent`，媒体类型为 `application/json`。新请求包含 `text`、`tools`、`context`，执行后可附带最多两轮 `history`。每轮包含原调用 `calls` 和按 ID 一一对应的 `results`，字段见 `shared/control.ts`。文本去除两端空白后长度为 1–1000 个 Unicode 码点，读取请求体的等待上限为 5 秒。旧请求只含 `text`，保持 4096 字节上限。
- 成功返回 HTTP 200，新契约为 `toolCalls` 与 `reply`，工具调用包含 `id`、`name`、`arguments`。无调用时 `reply` 是简短追问或提示。旧契约返回 `ventilate` 或 `unsupported`。错误返回固定 `error.code`。
- HTTP 状态分别为 400 输入格式错误、403 来源不允许、404 路径不存在、405 方法不支持、408 请求体读取超时、413 请求体过大、415 媒体类型不支持、429 配额不足、502 上游失败或输出非法、503 服务配置或配额服务不可用、504 模型调用超时。
- JSON 响应使用 `Cache-Control: no-store`。允许来源的成功和失败响应均带跨域响应头。429 同时提供 `Retry-After`。

## 3. 来源与密钥

`ALLOWED_ORIGINS` 按逗号分隔配置完整 origin，例如 `https://用户名.github.io` 和显式配置的本地开发 origin。origin 只包含协议、主机和端口，Pages 仓库子路径属于前端地址路径。

接口验证来源白名单，并支持只请求 POST 和 Content-Type 的 OPTIONS 预检。缺失 Origin 和白名单外来源返回 403。跨域规则与服务端用量控制同时执行。

模型 Key 存放在部署平台 Secret。本地使用被 Git 忽略的 `server/.env.local`，公开的 `.env.example` 中 Key 留空。Wrangler 兼容 `.dev.vars`，两种实际配置择一使用。错误响应统一映射为固定错误代码，运行代码只记录状态、耗时等必要指标时才增加日志。

## 4. 模型约束

系统提示要求缺少信息时追问；只描述闷热等感受时先给自然建议，不调用工具。完整请求或结合上下文可以确定的答复直接生成调用。用户修改的对象和方向优先，不能先执行旧建议，也不能要求明确指令再次回答「可以」。执行前不声称完成。旧分类链路仍返回 `ventilate` 或 `unsupported`。

兜底模型选定为阿里云 `qwen3.8-omni-flash`，从环境配置读取模型名称、完整 HTTP 接口和 Key。该模型使用文本输出并通过 `reasoning_effort: "none"` 关闭思考，完成单轮意图判定。[模型参数说明](https://help.aliyun.com/en/model-studio/qwen-omni)

新链路使用非流式 Function Calling，模型通过当前 `tools` 自动选函数，`finish_reason` 为 `tool_calls` 时验证所有调用，为 `stop` 时显示追问。意图、车辆状态和工具能力随本次请求注入。一次已获配额的请求至多调用一次模型，保持约 8 秒超时、64 KiB 上游响应上限及拒绝重定向策略。旧分类契约使用单字段 JSON 输出。

有 `history` 时重建 `assistant.tool_calls` 与逐条 `role: tool` 消息，保留完整调用 ID 和结构化回执，注入最新状态及剩余重试额度。模型只能重试初次 `failed` 且 `retryable=true` 的原函数与原参数，并使用新调用 ID。服务端硬校验范围，拒绝成功项重放、改参、新动作、重复操作及第三次执行。不存在可重试项或已重试时强制 `tool_choice: none`。

结构化回执区分 `succeeded`、`failed`、`not_run`，包括生效情况、错误类别与实际状态。原回执全部保留，模型应准确总结部分完成。同批工具必须相互独立；依赖流程不在本次范围。浏览器实际执行与是否幂等由工具注册模块负责，服务端不执行车辆动作，也不将客户端历史视为服务端授权凭据。

## 5. 配额与故障

默认每客户端每 60 秒最多调用 5 次，全站每 UTC 日最多调用 100 次。两个限额可通过服务端配置在规定范围内调整。客户端来源使用 Cloudflare 提供的连接 IP，并转为当日哈希键保存；本地开发共用一个客户端键。

初次规划、首次回执判断、重试后总结各自预留额度，一批最多 3 次模型请求。结果复核限流或超时不撤销已执行动作，前端保留回执并展示本地汇总。

单个 Durable Object 在存储事务内同时检查并递增客户端计数与全站日计数。实例重启后继续使用持久计数。过期日计数在下一次请求时重建。上游失败或超时也消耗已预留次数，以请求次数和固定输入输出上限约束用量。配额存储异常返回 503。

## 6. 验证与完成条件

1. 输入测试覆盖合法文本、空文本、非字符串、意外字段、非法 JSON、UTF-8 字节限制和流式超长请求体。
2. HTTP 测试覆盖路径、方法、来源、预检、媒体类型和错误响应跨域头。
3. 模型替身测试覆盖两种有效意图、请求参数、输出校验、截断、超时、网络和上游错误，以及响应体大小限制。
4. 配额测试覆盖客户端窗口、跨客户端全站限额、UTC 日切换、并发预留与持久状态恢复。
5. 通过服务端独立类型检查、测试和 Worker dry-run 打包，验证与原根项目构建兼容。用本地 Worker 运行时验证 HTTP 入口和 Durable Object 绑定。
6. README 提供本地运行、测试、服务端 Secret 配置、独立部署和前端接入方法。真实服务商调用与线上 Pages 跨域联调需要所选模型的有效凭据和部署账号，实施结果中单独记录验证状态。
7. 回执测试验证全部结果按 ID 注入、只重试失败项、重试后禁止继续调用、拦截重放／改参／复用 ID，以及缺失、重复或超限历史在调用模型前被拒绝。

部署约定依据 Cloudflare 的 Worker Secret、Durable Object 存储和 Wrangler 配置。Chat Completions 协议可参考模型服务商提供的兼容接口说明。[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Durable Object 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) · [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) · [模型兼容接口示例](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
