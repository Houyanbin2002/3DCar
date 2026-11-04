# 3DCar 模型接口

本分支实现独立部署的意图接口，对齐 [SPEC.md](./SPEC.md) 与 `shared/intent.ts`。前端识别唤醒词并处理明确指令，接口将间接表达分类为通风或不支持，页面负责追问和确认。

## 本地开发与验证

使用 Node.js 22.12+ 的 22.x 版本，在 `server` 目录执行以下命令。

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
```

在 `.dev.vars` 填写模型服务商提供的完整 `MODEL_API_URL`、`MODEL_NAME` 和 `MODEL_API_KEY`，然后运行 `npm run dev`。默认监听 `http://127.0.0.1:8787`。本地配额状态保存在被 Git 忽略的 `.wrangler/` 中。

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
| `MODEL_API_URL` | 服务商的完整 HTTPS Chat Completions 地址。接口使用 Bearer 鉴权和 JSON 输出，要求返回 `choices[0].message.content` 与 `finish_reason: "stop"`。 |
| `MODEL_NAME` | 与接口和 Key 相匹配的模型标识。选用支持 `response_format: json_object`、`max_tokens` 和非流式响应的聊天模型。 |
| `MODEL_API_KEY` | 部署平台 Secret。本地使用 `.dev.vars`，生产环境使用 Wrangler Secret。 |
| `ALLOWED_ORIGINS` | 逗号分隔的完整来源。默认配置只列出两个本地开发来源。发布时配置实际的 `https://用户名.github.io`，按需要保留开发来源。 |
| `CLIENT_REQUESTS_PER_MINUTE` | 每客户端每 60 秒可预留的请求数，默认 5，范围 1–1000。 |
| `DAILY_REQUEST_LIMIT` | 全站每 UTC 日可预留的请求数，默认 100，范围 1–10000。 |
| `MODEL_TIMEOUT_MS` | 上游请求与响应读取的总等待上限，默认 8000 ms，范围 1–30000 ms。 |

模型调用失败和超时也计入已预留次数。配额在 Durable Object 的事务中更新，并跨实例重启保留。持久状态仅包含当日用量、客户端当日哈希与窗口计数。请求次数字段和固定文本、输出上限共同约束演示用量。

## 独立发布与前端接入

1. 在 Cloudflare 账号下准备 Worker，按实际演示需要在 `wrangler.jsonc` 中填写来源、模型完整地址与名称。现有配置已经声明 SQLite-backed Durable Object 绑定和首次迁移。
2. 在 `server` 中通过 `npx wrangler login` 登录，使用 `npm run deploy` 发布，再用 `npx wrangler secret put MODEL_API_KEY` 交互式写入服务端 Key。按实际服务商选择模型与所属区域，验证部署环境能访问该模型接口。
3. 前端构建环境配置 `VITE_INTENT_API_URL=https://实际Worker地址/api/intent`。此值是公开接口地址。前端用 `Content-Type: application/json` 发送 POST，读取两个合法意图，并处理非 2xx 状态。
4. 从实际 Pages origin 验证 OPTIONS、POST、模型建议、用户确认与动画联动。核验前端产物只包含接口地址，模型 Key 由服务端配置提供。

首次本地测试可以先用自动化测试里的模型替身验证业务行为。实际中文分类效果、服务商兼容性和线上网络延迟，通过有效模型凭据和正式部署环境验收。

## 接口与故障

成功返回 `{"intent":"ventilate"}` 或 `{"intent":"unsupported"}`。错误返回固定的 `error.code`，对应状态和限制详见 SPEC。429 附 `Retry-After`，允许来源的错误响应也带跨域头。前端在超时或错误时提示用户说出具体部件指令。

来源校验、服务端调用频率和全站日额度一起约束公开演示接口。部署区域、模型服务商和额度应配合实际演示规模配置。
