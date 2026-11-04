# 3DCar Demo

基于 FormDrive Tesla Model 3 车模的网页交互展厅。车辆交互分支已合入 `codex/integration`，项目首页可直接体验白色展厅、地面倒影、拖转缩放、四门四窗及前后备箱独立控制、车窗双向轻点与长按、雨刮启停。语音和模型接口按各自功能分支继续联调。

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

## 项目文档

- [需求文档](./3D仿真车模交互Demo需求文档.md)
- [落地方案与项目架构](./3D仿真车模Demo落地方案与项目架构.md)
- [模块拆分与并行开发](./3DCar模块拆分与并行开发.md)
