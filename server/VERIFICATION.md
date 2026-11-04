# 模型接口分支验证记录

日期为 2026-11-04，工作区为 `3DCar-intent-api`，分支为 `codex/intent-api`。运行环境使用 Node.js 22.23.1。实现范围限定在 `server/**`，公共 `shared/intent.ts` 和根依赖沿用基线。

| 检查 | 结果 |
| --- | --- |
| 服务端依赖安装与类型检查 | 通过。服务端依赖和锁文件独立放在 `server/`。 |
| `cd server` 后执行 `npm test` | 17 项测试通过，覆盖输入、流式请求大小与超时、CORS、受限模型输出、网络与模型响应超时、配额窗口、UTC 日切换、并发和状态恢复。 |
| `cd server` 后执行 `npm run build` | Worker dry-run 打包通过，识别到 `INTENT_QUOTA` 绑定。 |
| 根目录 `npm ci` 与 `npm run build` | 通过，TypeScript 与 Vite 构建均成功。 |
| 本地 Wrangler HTTP 检查 | 正确来源的预检返回 204，非允许来源返回 403。临时限额为每客户端 2 次，5 个并发 POST 中 2 个进入测试上游，3 个返回 429，附 `Retry-After`。测试上游使用占位 HTTPS 地址，其失败映射为 502。 |
| 日额度 HTTP 检查 | 使用全站日额度 2 运行时，额度耗尽后返回 429，`Retry-After` 指向下一 UTC 日。 |

真实模型的中文分类效果、模型服务商参数兼容性、Cloudflare 正式部署以及 GitHub Pages 来源联调，需要有效凭据和实际站点 origin 后验证。相应步骤见 [README](./README.md)。自动化测试通过注入模型替身验证接口行为。
