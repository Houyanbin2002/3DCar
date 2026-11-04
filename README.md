# 3DCar Demo

基于 FormDrive Tesla Model 3 车模的网页交互展厅。当前仓库提供可启动和构建的开发基线，车模、控车、语音与模型接口由各功能分支实施。

## 本地启动

使用 Node.js 22.12 或更高的 22.x 版本。

```bash
npm ci
npm run dev
```

运行 `npm run typecheck` 检查 TypeScript，运行 `npm run build` 生成 `dist/`，运行 `npm run preview` 预览构建结果。GitHub Pages 项目站点构建时通过 `PAGES_BASE` 设置 `/<仓库名>/`。

## 项目文档

- [需求文档](./3D仿真车模交互Demo需求文档.md)
- [落地方案与项目架构](./3D仿真车模Demo落地方案与项目架构.md)
- [模块拆分与并行开发](./3DCar模块拆分与并行开发.md)
