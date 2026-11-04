# 车辆交互分支验证

使用 Node.js 22.12+ 的 22.x 版本，从 worktree 根目录执行。

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

打开 [车辆交互验证页](http://127.0.0.1:5174/dev/vehicle-interaction/)。页面装配 `Showroom`、`createVehicleController()` 和 `PartPanel`，可独立检查十个部件的开合、车身点击和半透明小窗。右侧模拟动力状态由控制器的引擎动作更新，供语音分支接线。

## 自动检查

```bash
npm run typecheck
node --test dev/vehicle-interaction/controller.test.mjs
npm exec vite build -- --config dev/vehicle-interaction/vite.config.ts
```

独立构建入口由本目录的 Vite 配置指定。Pages 子路径检查时设置环境变量 `PAGES_BASE=/3DCar/` 后再执行独立构建命令。根项目的 `npm run build` 用于公共入口构建。

开发服务器运行期间，可执行真实浏览器交互检查。

```bash
node dev/vehicle-interaction/browser-check.mjs
```

检查默认使用 Windows 桌面 Chrome。通过 `BROWSER_PATH` 环境变量可指定 Edge 或其他 Chromium 浏览器的可执行文件。脚本用独立临时用户目录启动无头浏览器，默认启用软件 WebGL，截图写入系统临时目录。软件渲染的运行速度与桌面 GPU 不同，需在实际演示设备复验拖转流畅度。

检查静态构建时，可通过 `PREVIEW_URL` 指定完整页面地址，例如 `http://127.0.0.1:5175/3DCar/dev/vehicle-interaction/`。预览服务器的 `PAGES_BASE` 与构建时保持一致。

## 联调接入

联调入口创建一次 `createVehicleController()`，将场景驱动回调交给 `controller.attachScene`，将部件点击交给 `controller.togglePart`，并把同一控制器传入 `PartPanel` 和语音模块。`Showroom` 占满父容器，外层提供明确的高度。`PartPanel` 可放在绝对定位的悬浮容器中，其样式只作用于组件类名。

模型文件来自 FormDrive 提交 `e2f861630035385adacd1c5fcdeae5258557cce6`。模型归属见 `public/models/TESLA-LICENSE.md`，移植逻辑的 MIT 声明见 `public/models/FORMDRIVE-LICENSE.md`。

## 验证记录

2026-11-04 已完成以下独立验证。

| 检查 | 结果 |
| --- | --- |
| 控制器自动测试 | 7 项通过。包含稳定快照、十个部件、组动作顺序、同部件并发、取消、驱动更换、动作失败和引擎状态。 |
| Chrome 156.0.8078.74 | 开发入口的完整浏览器脚本通过，覆盖面板开合、降窗后的热点、批量动作、拖拽保护、缩放、复位及门窗和前后备箱的直接拾取。 |
| Edge 156.0.4314.58 | `/3DCar/` 子路径下的静态构建通过同一套浏览器脚本。 |
| 构建与资源 | TypeScript 检查和独立 Vite 构建通过，GLB 构建前后哈希一致，模型和源码许可随静态产物发布。 |

两款浏览器的检查均在无头软件 WebGL 环境完成，过程中无未捕获异常。首版使用原始约 22.7 MB 的 GLB，构建工具会提示 Three.js 场景入口的产物超过默认体积提示阈值。首次加载时间和桌面 GPU 上的流畅度，在实际演示设备上复验。
