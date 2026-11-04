# 语音分支使用与验收

本模块对应 `codex/voice-control`，规格见 [SPEC.md](./SPEC.md)。独立验证页使用模拟车辆控制器记录动作，可切换模拟识别和浏览器麦克风。模拟模型仅用于验证建议及确认流程。

## 启动独立验证页

使用 Node.js 22.12+ 的 22.x 版本，在当前 worktree 执行以下命令。

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5176 --strictPort
```

访问 `http://127.0.0.1:5176/dev/voice/`，点击语音卡片上的「开启语音」，再从左侧发送模拟转写。每轮新请求需包含「小满小满」，等待确认时可直接发送「需要」「不用」，也可点击语音卡片中的确认按钮。

勾选「真实麦克风」后重新开启语音，浏览器会按授权流程启动识别。勾选「真实模型接口」时，读取工作区根目录 `.env.local` 中的公开接口地址，修改配置后重启 Vite。

```dotenv
VITE_INTENT_API_URL=https://your-api.example.com/api/intent
```

后端允许当前开发来源访问。前端只配置该公开地址，模型服务商密钥由后端配置。

当前兜底模型选定为阿里云 `qwen3.8-omni-flash`。服务端在 `server/.env.local` 中配置模型名称、完整 HTTP 地址和 Key，模板由模型接口分支的 `server/.env.example` 提供。本地联调可将前端公开地址设为 `http://127.0.0.1:8787/api/intent`，然后勾选「真实模型接口」。规则未命中或低置信度时，模型读取运行时工具定义并选择函数调用。页面验证后生成确认提示，确认后调用登记的执行方法。

通过 `<VoicePanel controller={controller} tools={tools} />` 注入稳定的注册表实例。省略 `tools` 时自动注册部件、门窗整组和引擎工具。运行时新增工具的完整示例见 [TOOLS.md](./TOOLS.md)。

## 接入真实车辆控制器

联调分支在 `App.tsx` 中将已创建的公共车辆控制器传给组件，并由外层布局决定小窗位置。

```tsx
import { VoicePanel } from './ui/VoicePanel';

<VoicePanel controller={controller} />
```

`VoicePanel` 内部创建并订阅语音状态机。`controller` 应保持实例稳定，`getSnapshot()` 和 `execute()` 遵循 `src/contracts/vehicle.ts`。控制器负责按顺序完成动作，并通过 `onResult` 回报每条动作。语音关闭或取消时，传给 `execute()` 的信号会中止尚未下发的动作。

需要独立嵌入或验证状态机时，可以实例化 `VoiceControl`，通过 `subscribe()` 与 `getSnapshot()` 订阅状态，并注入 `input`、`output`、`controlClient`、`tools`、`clock`。React 中可使用 `useVoiceControl()`。

## 自动验证

```bash
node src/voice/tests/run.mjs
npm run build
```

测试入口使用 Vite 锁定依赖中的 esbuild 在内存中转译，再运行 Node 内置测试。40 项测试覆盖规则、唤醒、确认、接口异常、运行时工具扩展，以及逐项回执、仅失败项重试、重试上限、改参或重放拦截和取消后的旧响应失效。

工具执行后会将逐项结果回传模型。可恢复的失败最多自动重试一轮，成功项不重复执行，最终显示实际完成与失败数量。扩展工具通过 `ToolExecutionError` 报告错误类型，并按实际语义声明幂等性与状态读取能力，详见 [TOOLS.md](./TOOLS.md)。

## 验收记录

2026-11-04 在 Node 22.23.1 环境完成自动测试、TypeScript 检查与生产构建。Chrome 和 Edge 的独立验证页均完成部分有效指令反馈、前后备箱顺序操作、确认后降窗、取消建议及关闭语音检查，页面无运行时错误。

浏览器页面验收使用模拟车辆、模拟转写与模拟模型。真实麦克风识别质量、中文播报、正式 HTTPS 模型接口和真实车模动作，在联调环境按 A04–A15 完成验收。

后续升级工具调用后，已在 Edge 验证完整规则控车不请求模型，未匹配的「把右后排那扇车窗放下来」经真实千问返回 `set_vehicle_part(rearRightWindow, true)`，确认后执行模拟车辆动作。临时注册温控工具后，真实模型也能选择该工具并将模拟温度设为 24 度。此项语音输入和车辆仍为模拟状态。

工具反馈闭环已通过本地 Worker 调用真实千问验证：模型生成左前门、左前窗、后备箱三条独立调用，模拟后备箱首次返回 `PART_BUSY`。三条回执回传后，模型仅重试后备箱，最终准确说明全部完成。三个执行器的实际调用次数为 1、1、2，共请求模型 3 次。该项执行器为模拟实现，未使用真实麦克风或 3D 动画。
