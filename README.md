# 3DCar Demo

基于 FormDrive Tesla Model 3 车模的网页交互展厅。车辆、语音与模型接口已合入 `codex/integration`，首页可直接体验白色展厅、地面倒影、拖转缩放、四门四窗及前后备箱独立控制、车窗双向轻点与长按、雨刮启停，以及「小满小满」唤醒控车。

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

首页左下方的半透明语音小窗与部件小窗共用同一个车辆控制器。点击「开启语音」并授权麦克风后，说「小满小满，打开左前车窗」。完整规则直接控车；「小满小满，车里有点闷热」等表达交给模型建议具体操作，确认后执行。浏览器不支持或语音异常时会显示提示。

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

## 项目文档

- [需求文档](./3D仿真车模交互Demo需求文档.md)
- [落地方案与项目架构](./3D仿真车模Demo落地方案与项目架构.md)
- [模块拆分与并行开发](./3DCar模块拆分与并行开发.md)
- [合并与联调验证记录](./docs/integration-verification.md)
