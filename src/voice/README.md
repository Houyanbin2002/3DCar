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

当前兜底模型选定为阿里云 `qwen3.8-omni-flash`。服务端在 `server/.env.local` 中配置模型名称、完整 HTTP 地址和 Key，模板由模型接口分支的 `server/.env.example` 提供。本地联调可将前端公开地址设为 `http://127.0.0.1:8787/api/intent`，然后勾选「真实模型接口」。模型输出通风意图后，页面提出具体开窗建议，收到确认再执行。

## 接入真实车辆控制器

联调分支在 `App.tsx` 中将已创建的公共车辆控制器传给组件，并由外层布局决定小窗位置。

```tsx
import { VoicePanel } from './ui/VoicePanel';

<VoicePanel controller={controller} />
```

`VoicePanel` 内部创建并订阅语音状态机。`controller` 应保持实例稳定，`getSnapshot()` 和 `execute()` 遵循 `src/contracts/vehicle.ts`。控制器负责按顺序完成动作，并通过 `onResult` 回报每条动作。语音关闭或取消时，传给 `execute()` 的信号会中止尚未下发的动作。

需要独立嵌入或验证状态机时，可以实例化 `VoiceControl`，通过 `subscribe()` 与 `getSnapshot()` 订阅状态，并注入 `input`、`output`、`intentClient`、`clock`。React 中可使用 `useVoiceControl()`。

## 自动验证

```bash
node src/voice/tests/run.mjs
npm run build
```

测试入口使用 Vite 锁定依赖中的 esbuild 在内存中转译，再运行 Node 内置测试。覆盖 25 个用例，包括完整部件映射、共享动作、无标点多指令、部分有效、无唤醒、结果去重、5 秒超时、播报期间暂停识别、一次确认消费、取消与旧回调失效，以及模型接口异常。

## 验收记录

2026-11-04 在 Node 22.23.1 环境完成自动测试、TypeScript 检查与生产构建。Chrome 和 Edge 的独立验证页均完成部分有效指令反馈、前后备箱顺序操作、确认后降窗、取消建议及关闭语音检查，页面无运行时错误。

浏览器页面验收使用模拟车辆、模拟转写与模拟模型。真实麦克风识别质量、中文播报、正式 HTTPS 模型接口和真实车模动作，在联调环境按 A04–A15 完成验收。

后续已补充 Edge 的真实模型联调。前端经本地 Worker 调用 `qwen3.8-omni-flash`，收到通风意图后显示建议，确认后才打开模拟车辆的左前窗，页面无运行时错误。此项语音输入和车辆仍为模拟状态。
