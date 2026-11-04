# 3DCar 模型接口

本分支实现独立部署的模型接口，对齐 [SPEC.md](./SPEC.md)、`shared/control.ts` 和兼容的 `shared/intent.ts`。前端优先处理完整规则，接口将当前工具定义通过 Function Calling 注入千问，返回函数调用或简短追问。页面校验后执行已登记的工具。

## 本地开发与验证

使用 Node.js 22.12+ 的 22.x 版本，在 `server` 目录执行以下命令。

```powershell
npm ci
Copy-Item .env.example .env.local
```

在 `.env.local` 填写 `MODEL_API_KEY`，然后运行 `npm run dev`。当前选定的兜底模型为 `qwen3.8-omni-flash`，示例使用阿里云北京地域的兼容 HTTP 地址。其他地域使用对应地域和工作空间的完整地址，Key 与地址需匹配。默认监听 `http://127.0.0.1:8787`。本地配额状态保存在被 Git 忽略的 `.wrangler/` 中。

Wrangler 也支持原有 `.dev.vars` 配置。该文件存在时会优先读取它，使用 `.env.local` 时应避免同时保留另一份实际配置。[本地环境变量说明](https://developers.cloudflare.com/workers/configuration/environment-variables/)

```powershell
$requestBody = @{ text = '车里有点闷热' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/intent' `
  -Headers @{ Origin = 'http://localhost:5173' } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($requestBody))
```

独立验证分别执行 `npm run typecheck`、`npm test` 和 `npm run build`。测试使用模型替身覆盖输入、CORS、输出、超时及配额，`build` 在本地执行 Worker dry-run。根项目另外执行 `npm ci` 和 `npm run build` 验证合并兼容性。

## 服务端配置

| 配置 | 用途与默认值 |
| --- | --- |
| `MODEL_API_URL` | 服务商的完整 HTTPS Chat Completions 地址。接口使用 Bearer 鉴权，支持标准 `tool_calls`、`role: tool` 和文本回复；旧分类链路使用 JSON 输出。 |
| `MODEL_NAME` | 本项目选用 `qwen3.8-omni-flash`。服务端对该模型附加 `modalities: ["text"]` 与 `reasoning_effort: "none"`，用于低延迟的单轮意图判定。 |
| `MODEL_API_KEY` | 部署平台 Secret。本地使用被 Git 忽略的 `.env.local`，生产环境使用 Wrangler Secret。 |
| `ALLOWED_ORIGINS` | 逗号分隔的完整来源。默认配置只列出两个本地开发来源。发布时配置实际的 `https://用户名.github.io`，按需要保留开发来源。 |
| `CLIENT_REQUESTS_PER_MINUTE` | 每客户端每 60 秒可预留的请求数，默认 5，范围 1–1000。 |
| `DAILY_REQUEST_LIMIT` | 全站每 UTC 日可预留的请求数，默认 100，范围 1–10000。 |
| `MODEL_TIMEOUT_MS` | 上游请求与响应读取的总等待上限，默认 8000 ms，范围 1–30000 ms。 |

模型调用失败和超时也计入已预留次数。配额在 Durable Object 的事务中更新，并跨实例重启保留。持久状态仅包含当日用量、客户端当日哈希与窗口计数。请求次数字段和固定文本、输出上限共同约束演示用量。

Qwen Omni 的文本输出、JSON 模式及思考参数依据阿里云官方说明。工具调用及参数经前后端校验后，由页面发起确认并执行。[Qwen Omni 文档](https://help.aliyun.com/en/model-studio/qwen-omni)

## 独立发布与前端接入

1. 在 Cloudflare 账号下准备 Worker，按实际演示需要在 `wrangler.jsonc` 中填写来源、模型完整地址与名称。现有配置已经声明 SQLite-backed Durable Object 绑定和首次迁移。
2. 在 `server` 中通过 `npx wrangler login` 登录，使用 `npm run deploy` 发布，再用 `npx wrangler secret put MODEL_API_KEY` 交互式写入服务端 Key。按实际服务商选择模型与所属区域，验证部署环境能访问该模型接口。
3. 前端构建环境配置 `VITE_INTENT_API_URL=https://实际Worker地址/api/intent`。此值是公开接口地址。前端用 `Content-Type: application/json` 发送 POST，校验工具调用与回复，并处理非 2xx 状态。
4. 从实际 Pages origin 验证 OPTIONS、POST、模型建议、用户确认与动画联动。核验前端产物只包含接口地址，模型 Key 由服务端配置提供。

首次本地测试可以先用自动化测试里的模型替身验证业务行为。实际中文分类效果、服务商兼容性和线上网络延迟，通过有效模型凭据和正式部署环境验收。

## 接口与故障

`POST /api/intent` 接收带 `text`、`tools`、`context` 的新请求，返回 `toolCalls` 与 `reply`。工具定义由页面注册表动态生成，最多 16 项，参数支持字符串枚举、数值范围和布尔值。工具请求体最多 32 KiB，模型输出最多 512 tokens、8 条调用。返回的名称和实参必须符合本次工具结构。

工具执行后，附带 `history: [{ calls, results }]` 再次请求。`results` 包含对应调用的 `toolCallId`、`status`、`effect`、`message`、错误码和重试资格，以及可读取的实际状态。后端以标准 `assistant.tool_calls` 和 `role: tool` 消息回传千问，最多接受两轮历史。[千问 Function Calling 协议](https://help.aliyun.com/en/model-studio/qwen-function-calling)

自动重试仅允许初次可恢复失败的同函数、同参数操作，使用新调用 ID；最多一轮。已成功项、取消项、新目标、改参和超次数的调用会被前后端拦截。没有可重试项或重试结束后强制只生成总结。同批仅支持独立动作，执行资格由页面注册模块决定。

初次规划、结果判断及重试后总结最多共 3 次模型请求，各次单独计入限额。复核接口失败时，页面保留实际回执和本地汇总。

只含 `text` 的旧请求继续返回 `ventilate` 或 `unsupported`，保持 4 KiB 输入和 64 tokens 输出上限。错误返回固定 `error.code`，429 附 `Retry-After`，允许来源的错误响应也带跨域头。

来源校验、服务端调用频率和全站日额度一起约束公开演示接口。部署区域、模型服务商和额度应配合实际演示规模配置。
