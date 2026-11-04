# 模型接口分支验证记录

日期为 2026-11-04，工作区为 `3DCar-intent-api`，分支为 `codex/intent-api`。运行环境使用 Node.js 22.23.1。实现范围限定在 `server/**`，公共 `shared/intent.ts` 和根依赖沿用基线。

| 检查 | 结果 |
| --- | --- |
| 服务端依赖安装与类型检查 | 通过。服务端依赖和锁文件独立放在 `server/`。 |
| `cd server` 后执行 `npm test` | 23 项测试通过，覆盖旧分类兼容、运行时函数定义、参数校验、输入及响应上限、CORS、拒绝重定向、超时和配额状态。 |
| `cd server` 后执行 `npm run build` | Worker dry-run 打包通过，识别到 `INTENT_QUOTA` 绑定。 |
| 根目录 `npm ci` 与 `npm run build` | 通过，TypeScript 与 Vite 构建均成功。 |
| 本地 Wrangler HTTP 检查 | 正确来源的预检返回 204，非允许来源返回 403。临时限额为每客户端 2 次，5 个并发 POST 中 2 个进入测试上游，3 个返回 429，附 `Retry-After`。测试上游使用占位 HTTPS 地址，其失败映射为 502。 |
| 日额度 HTTP 检查 | 使用全站日额度 2 运行时，额度耗尽后返回 429，`Retry-After` 指向下一 UTC 日。 |

本次补充验证使用阿里云 `qwen3.8-omni-flash`，本地凭据保存在 Git 忽略的 `server/.env.local`。通过北京兼容 HTTP 地址实测「车里有点闷热，想透透气」返回 `ventilate`，直接模型调用约 983 ms。「不用开窗」通过本地 Worker 返回 `unsupported`。

Edge 独立语音验证页已走通真实 HTTP 链路，前端请求本地 Worker，Worker 调用实际千问模型，页面先显示具体建议，再由点击「需要」驱动模拟车辆的左前窗。此项使用模拟语音输入与模拟车辆，模型调用为真实服务。Cloudflare 正式部署、GitHub Pages 来源、真实麦克风和真实车模联动在集成环境验收。

本地 Worker 验证同时发现并修复了 `redirect: "error"` 的运行时兼容问题，改用 `manual` 并拒绝非成功状态。已有独立回归用例验证上游重定向返回 502。[Worker 请求参数说明](https://developers.cloudflare.com/workers/runtime-apis/request/)

工具调用升级后，真实千问已分别将「车里有点闷热」和「把右后排那扇车窗放下来」转为具体 `set_vehicle_part` 调用。临时注册 `set_cabin_temperature` 的 Schema 后，同一接口立即返回该新工具和 `celsius: 24`，通过对应模拟执行器验证。

Edge 页面联调确认明确规则未产生模型请求，自然说法产生一次真实模型请求。页面在确认前保持车窗关闭，确认后执行右后窗工具并同步界面状态，页面无运行时错误。
