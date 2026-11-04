# 模型接口分支规格

| 项目 | 约定 |
| --- | --- |
| 版本与日期 | v1.0，2026-11-04 |
| 分支与工作区 | `codex/intent-api`，`3DCar-intent-api` |
| 需求依据 | 需求 v1.3 的 §4.4、§5、A13–A15，架构 v1.2 的 §5 |
| 公共契约 | `shared/intent.ts` |
| 本分支路径 | `server/**` |
| 运行方式 | Cloudflare Worker 接受 HTTPS 请求，单个 Durable Object 原子预留调用额度 |

## 1. 行为与职责

页面完成唤醒和本地规则判定后，把本轮转写提交到接口。接口只判定 `ventilate` 或 `unsupported`。前端选择车窗、生成追问，并在用户确认后执行动作。

服务端适配通过 Bearer Key 鉴权、使用 `messages` 输入和 `choices[0].message.content` 输出的 Chat Completions 兼容接口。完整 HTTPS 地址、模型标识和 Key 从运行环境读取。发布时按所选服务商验证兼容性和真实中文意图效果。

## 2. HTTP 契约

- 路径为 `POST /api/intent`。媒体类型为 `application/json`，请求对象只能包含字符串 `text`。文本去除两端空白后，长度为 1–1000 个 Unicode 码点。实际请求体上限为 4096 字节，读取请求体的等待上限为 5 秒。
- 成功返回 HTTP 200 和 `{"intent":"ventilate"}` 或 `{"intent":"unsupported"}`，遵守公共类型。错误返回 `{"error":{"code":"错误代码"}}`。
- HTTP 状态分别为 400 输入格式错误、403 来源不允许、404 路径不存在、405 方法不支持、408 请求体读取超时、413 请求体过大、415 媒体类型不支持、429 配额不足、502 上游失败或输出非法、503 服务配置或配额服务不可用、504 模型调用超时。
- JSON 响应使用 `Cache-Control: no-store`。允许来源的成功和失败响应均带跨域响应头。429 同时提供 `Retry-After`。

## 3. 来源与密钥

`ALLOWED_ORIGINS` 按逗号分隔配置完整 origin，例如 `https://用户名.github.io` 和显式配置的本地开发 origin。origin 只包含协议、主机和端口，Pages 仓库子路径属于前端地址路径。

接口验证来源白名单，并支持只请求 POST 和 Content-Type 的 OPTIONS 预检。缺失 Origin 和白名单外来源返回 403。跨域规则与服务端用量控制同时执行。

模型 Key 存放在部署平台 Secret。本地使用 `server/.dev.vars`，由本分支的 `.gitignore` 忽略。公开配置示例使用占位值。错误响应统一映射为固定错误代码，运行代码只记录状态、耗时等必要指标时才增加日志。

## 4. 模型约束

系统提示明确通风意图的范围，包括车内闷热、空气闷、想透气等单轮表达。明确拒绝开窗、指令注入、闲聊和其他无关内容归为 `unsupported`。用户转写通过独立 user 消息传入。

模型使用非流式 JSON 输出，输出 token 上限为 64。只有精确的单字段 JSON 对象和两个枚举值可通过校验。输出截断、意外字段、解释文字和非法 JSON 都返回 502。接口在约 8 秒内完成上游请求及响应体读取，响应体上限为 64 KiB，超时返回 504。一次已获配额的请求至多发起一次模型调用，重定向作为上游失败处理。

## 5. 配额与故障

默认每客户端每 60 秒最多调用 5 次，全站每 UTC 日最多调用 100 次。两个限额可通过服务端配置在规定范围内调整。客户端来源使用 Cloudflare 提供的连接 IP，并转为当日哈希键保存；本地开发共用一个客户端键。

单个 Durable Object 在存储事务内同时检查并递增客户端计数与全站日计数。实例重启后继续使用持久计数。过期日计数在下一次请求时重建。上游失败或超时也消耗已预留次数，以请求次数和固定输入输出上限约束用量。配额存储异常返回 503。

## 6. 验证与完成条件

1. 输入测试覆盖合法文本、空文本、非字符串、意外字段、非法 JSON、UTF-8 字节限制和流式超长请求体。
2. HTTP 测试覆盖路径、方法、来源、预检、媒体类型和错误响应跨域头。
3. 模型替身测试覆盖两种有效意图、请求参数、输出校验、截断、超时、网络和上游错误，以及响应体大小限制。
4. 配额测试覆盖客户端窗口、跨客户端全站限额、UTC 日切换、并发预留与持久状态恢复。
5. 通过服务端独立类型检查、测试和 Worker dry-run 打包，验证与原根项目构建兼容。用本地 Worker 运行时验证 HTTP 入口和 Durable Object 绑定。
6. README 提供本地运行、测试、服务端 Secret 配置、独立部署和前端接入方法。真实服务商调用与线上 Pages 跨域联调需要所选模型的有效凭据和部署账号，实施结果中单独记录验证状态。

部署约定依据 Cloudflare 的 Worker Secret、Durable Object 存储和 Wrangler 配置。Chat Completions 协议可参考模型服务商提供的兼容接口说明。[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Durable Object 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) · [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/) · [模型兼容接口示例](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
