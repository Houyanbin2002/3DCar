# 中文识别与语音交互改进验证

日期：2026-11-04。开发入口 `http://127.0.0.1:5173/`，本次主工作区 Worker 使用 `http://127.0.0.1:8790`。凭据保存在被 Git 忽略的服务端本地配置。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `node src/voice/tests/run.mjs` | 57 项通过，增加了模型意图直接执行、全部降窗替换单窗建议、上下文升窗、待确认计划修改后不执行旧建议。保留扩展工具确认策略及原有规则、20 秒窗口和重试验证。 |
| `npm --prefix server test` | 36 项通过：原有模型与配额、对话消息校验与注入、ASR 参数及事件、音频限制、超时和来源限制。 |
| `node --test dev/vehicle-interaction/controller.test.mjs` | 13 项通过。 |
| `npm run build` | TypeScript 与生产构建通过；保留已有 Three.js 包体积提示。 |
| `npm --prefix server run build` | Worker dry-run 通过。 |

## 真实中文识别服务

通过本地 Worker 实际连接 `qwen-audio-3.1-asr-flash-message`，固定中文与车辆热词。使用 Windows Huihui、Kangkang、Yaoyao 三种合成音色生成单声道 16 kHz PCM16 音频，按实时速率上传。

已完整测试 16 条：唤醒词、四窗、车门、前后备箱、多指令、间接闷热表达、25% / 50% / 完全开窗、确认「可以」、否定「不用」及普通闲聊。去除标点与空白后，16/16 完整转写匹配；13/13 含唤醒词样本匹配；3 条不含唤醒词样本未生成唤醒词。结果保存在临时语料目录的 `results.json`。

这是小规模、安静条件下的合成音频验证，不代表真人麦克风、口音、距离和噪声下有相同准确率。实际演示仍需用演示者与现场设备试说。没有宣称识别达到 100% 的通用保证。

## 浏览器与实际车模

最新意图驱动版本通过 Chrome 的真实音频与千问测试：说「车里有点闷热」后，模型先给自然建议，车窗保持关闭；直接回复「帮我降下全部车窗吧」后四窗降到底；随后说「那你帮我升起吧」四窗全部升起。全程没有说「可以」、没有点击确认、页面从未进入额外 `confirming` 状态，至少 5 次真实模型请求。最终保留 20 秒免唤醒窗口。

浏览器检查仅把麦克风源替换为可重复 WAV 音频。音频仍经过实际 AudioContext、AudioWorklet、WebSocket、Worker 与真实 ASR，模型建议使用真实千问，动作通过正式车辆控制器及 GLB 动画完成；没有注入转写结果或点击确认按钮。

已在 Chrome 验证：

- 「车里有点闷热」经真实模型产生左前窗建议；识别恢复后超过 6 秒仍可回答「可以」，随后实际降窗并回传结果。
- 「把左前车窗打开一点」不请求语言模型，实际左前窗开度为 0.25。
- 「车窗打开一半」先说明所有四窗，经语音「可以」后四窗实际开度均为 0.5；不请求语言模型。
- 连续对话真实链路：「把窗户放到一半的位置」→ 模型追问窗位 → 只答「左前车窗」→「可以」→ 实际左前窗 50% → 直接说「再低一点」→ 模型沿用窗位与当前状态 →「可以」→ 实际左前窗 75%。其余三窗保持关闭，至少 5 次真实模型请求，页面无未捕获异常。

Edge 生产构建预览页也已通过真实音频「车窗打开一半」与语音「可以」，四窗实际均到 50%。自动浏览器通过前台聚焦和关闭后台节流保持动画运行，页面无未捕获异常。

## 复现

先启动前端和已配置 Key 的 Worker。若 Worker 使用其他端口，修改前端公开地址并设置 `ASR_TEST_URL`。

```powershell
& .\dev\voice\create-speech-corpus.ps1
$env:ASR_CORPUS_DIR = Join-Path $env:TEMP '3dcar-asr-corpus'
npm --prefix server run test:speech-live
# 比例车窗及纯语音确认
$env:SPEECH_AMOUNT = '0.25'
node dev/voice/speech-browser-check.mjs
$env:SPEECH_AMOUNT = '0.5'
node dev/voice/speech-browser-check.mjs
# 连续澄清及相对调整
$env:SPEECH_DIALOGUE = '1'
node dev/voice/speech-browser-check.mjs
```

语料脚本现包含 22 条，其中后 6 条用于连续对话和修改意图检查。设置 `SPEECH_INTENT=1` 后运行同一浏览器脚本，可复现直接全部降窗再升窗。服务端 Secret 不进入前端代码或测试输出。线上 Pages / WSS 仍需从正式地址单独验收。
