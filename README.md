# 3DCar Demo

基于 FormDrive Tesla Model 3 车模的网页交互展厅。首页集成车辆控制、语音与模型接口，可直接体验白色展厅、地面倒影、拖转缩放、四门四窗及前后备箱独立控制、车窗双向轻点与长按、雨刮启停，以及「小满同学」唤醒控车。

## 本地启动

使用 Node.js 22.12 或更高的 22.x 版本。

```bash
npm ci
npm run dev
```

运行 `npm run typecheck` 检查 TypeScript，运行 `npm run build` 生成 `dist/`，运行 `npm run preview` 预览构建结果。GitHub Pages 项目站点构建时通过 `PAGES_BASE` 设置 `/<仓库名>/`。

## 车辆交互验证

正式页面 `/` 与独立验证入口 `/dev/vehicle-interaction/` 共用 `src/ui/VehicleShowroom.tsx`，统一装配场景、控制器和小窗。

```bash
node --test dev/vehicle-interaction/controller.test.mjs
node dev/vehicle-interaction/browser-check.mjs
```

浏览器脚本默认检查独立开发入口。检查正式构建时设置 `PREVIEW_URL` 为预览地址；运行环境、子路径构建和测试范围见 [车辆交互验证说明](./dev/vehicle-interaction/README.md)。

## 语音与模型接口

首页右侧的半透明悬浮面板同时展示车门、车窗和备箱，语音控制位于同一面板下方。按钮用颜色和悬停提示反馈状态。点击「开启语音」并授权麦克风后，说「小满同学，打开左前车窗」。完整规则直接控车；「小满同学，车里有点闷热」等表达交给模型建议具体操作，确认后执行。浏览器不支持或语音异常时会显示提示。

默认识别已升级为千问中文实时 ASR，配置唤醒词和车辆热词，通过独立 Worker 转发音频，Key 保存在后端。建议播报结束、识别恢复就绪后有 15 秒确认时间，直接说「可以」「需要」「好的」即可执行，无需再次唤醒或点击确认。

比例车窗口令：「把左前车窗打开一点」设为 25%，「所有车窗打开一半」设为 50%，「完全打开左前车窗」设为 100%。开度是绝对位置。泛指「车窗打开一半」会先询问是否操作全部四窗，回复「可以」后执行。控制区显示部分开启时的百分比。

每次语音操作完成后有 20 秒免唤醒窗口，可以直接继续说指令，下一次完成后重新计时；超时回到等待唤醒。规则未命中后进入模型连续对话，按追问直接补充「左前车窗」「一半」即可；也可继续说「再低一点」，模型会沿用已明确的窗位并读取当前开度，再次确认后调整。说「好了」「结束」「不用了」结束对话；尚在澄清时有 60 秒答复时间。

前端根目录 `.env.local` 只配置公开接口地址：

```dotenv
VITE_INTENT_API_URL=http://127.0.0.1:8787/api/intent
```

在 `server/` 安装依赖，将 `server/.env.example` 复制为 `server/.env.local`，在后者设置模型 Key，然后运行 `npm run dev`。实际配置文件已被 Git 忽略。Pages 发布时将公开接口地址改为独立部署的 HTTPS Worker 地址，并在服务端设置允许的 Pages 来源。详见 [模型接口说明](./server/README.md)。

模型使用当前注册的工具，通过逐项回执了解执行结果。可恢复的失败最多自动重试一轮，成功项不重复执行；详见 [工具与重试说明](./src/voice/TOOLS.md)。

```bash
node src/voice/tests/run.mjs
npm --prefix server test
npm --prefix server run build
```

语音模块的独立验证入口为 `/dev/voice/`，使用方式见 [语音验证说明](./src/voice/README.md)。真实中文识别质量和麦克风授权需在桌面 Chrome／Edge 上实际试说。

本次识别与纯语音确认的真实服务测试、浏览器车窗动画联调和复现方法见 [语音改进验证记录](./docs/speech-verification.md)。

## 项目文档

- [需求文档](./3D仿真车模需求文档.md)
- [落地方案与项目架构](./落地方案与项目架构.md)
- [模块拆分与并行开发](./模块拆分与并行开发.md)
- [合并与联调验证记录](./docs/integration-verification.md)
