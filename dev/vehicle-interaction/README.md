# 车辆交互分支验证

使用 Node.js 22.12+ 的 22.x 版本，从 worktree 根目录执行。

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

打开 [车辆交互验证页](http://127.0.0.1:5174/dev/vehicle-interaction/)。页面装配 `Showroom`、`createVehicleController()` 和 `PartPanel`，可独立检查十个部件的开合、车身点击和半透明小窗。右侧模拟动力状态由控制器的引擎动作更新，供语音分支接线。

车辆分支合入 `codex/integration` 后，项目正式首页也已装配同一套功能。`src/ui/VehicleShowroom.tsx` 为两个入口共用的装配组件，布局样式位于 `src/ui/vehicle-showroom.css`。

## 当前交互

- 白色展厅和半透明控制小窗，车身使用清漆材质、柔光环境反射，地面显示柔化倒影和阴影。
- 四个车窗各有“升起 / 降下”双按钮。轻点任一方向自动运行到位；按住超过 280 ms 后连续慢移，松开停在任意位置。支持拖出按钮松开、失焦停止，以及 Space / Enter 键操作。
- 自动升降全行程约 1.15 秒，长按慢移全行程约 2.3 秒。玻璃真实滑入门板，门板以下的部分被裁切；开门后仍能独立升降。停止时显示实际降下百分比，已取消半降预设。
- 雨刮有独立开关，开启后双臂循环摆动，关闭后完成当前周期并归位。

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

设置 `SOFTWARE_WEBGL=0` 时，由浏览器使用默认图形后端，适合在具备 GPU 的机器上验证交互和性能。

检查静态构建时，可通过 `PREVIEW_URL` 指定完整页面地址，例如 `http://127.0.0.1:5175/3DCar/dev/vehicle-interaction/`。预览服务器的 `PAGES_BASE` 与构建时保持一致。

## 联调接入

联调入口创建一次 `createVehicleController()`，将场景驱动回调交给 `controller.attachScene`，将部件点击交给 `controller.togglePart`，并把同一控制器传入 `PartPanel` 和语音模块。`Showroom` 占满父容器，外层提供明确的高度。`PartPanel` 可放在绝对定位的悬浮容器中，其样式只作用于组件类名。

契约保留原有三种动作类型。新增可选窗口位置、手势和雨刮接口，详见 [分支规格](../../docs/vehicle-interaction-spec.md)。`supportsWindowGestures`、`supportsWipers` 用于启用高级控件；雨刮通过控制器独立方法接入，语音模块可继续使用原有动作。联调时需要一并合入 `WindowButton`、展厅环境、反射地面和雨刮绑定文件。

模型文件来自 FormDrive 提交 `e2f861630035385adacd1c5fcdeae5258557cce6`。模型归属见 `public/models/TESLA-LICENSE.md`，移植逻辑的 MIT 声明见 `public/models/FORMDRIVE-LICENSE.md`。

## 验证记录

2026-11-04 已完成以下独立验证。

| 检查 | 结果 |
| --- | --- |
| 控制器与雨刮自动测试 | 13 项通过。包含稳定快照、十个部件、组动作顺序、同部件并发、取消、驱动更换、动作失败和引擎状态，以及手动双向升降、任意位置停止、提前释放、非法位置、旧驱动兼容和雨刮归位。 |
| Chrome 156.0.8078.74 | `/3DCar/` 子路径静态构建的完整浏览器脚本通过，覆盖双向真实轻点、长按慢移、按钮外松手停止、中途反向、雨刮归位，以及十部件开合、批量动作、热点、拖拽保护、缩放、复位与直接拾取。 |
| Edge 156.0.4314.58 | `/3DCar/` 子路径下的静态构建通过同一套浏览器脚本。 |
| 构建与资源 | TypeScript 检查和独立 Vite 构建通过，GLB 构建前后哈希一致，模型和源码许可随静态产物发布。 |

最新一轮两款浏览器均使用无头默认图形后端完成，过程中无未捕获异常；此前基础版本也通过软件 WebGL 检查。使用原始约 22.7 MB 的 GLB，构建工具会提示 Three.js 场景入口的产物超过默认体积提示阈值。实际演示设备的首次加载时间和屏幕呈现仍由设备、浏览器及网络决定。

## 拖动性能优化

定位到的主要耗时来自热点遮挡检测。资产包含约 68.4 万个三角面，原先每轮检测会对十个热点分别遍历车身几何体。现在用 `three-mesh-bvh` 为各几何体建立一次空间索引，点击和热点射线均查询最近命中。索引缓存于加载器共享的几何体，采用间接索引保留原始三角面排列，开门和降窗仍由各部件局部变换驱动。

在同一台 RTX A5000、Chrome 无头硬件渲染、1440×900、DPR 1 环境中，以约 5 秒连续拖动采样。

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 平均帧间隔 | 155.9 ms | 5.59 ms |
| 第 95 百分位帧间隔 | 227.7 ms | 5.7 ms |
| 单次射线查询最长耗时 | 44.3 ms | 0.6 ms |
| 每帧绘制调用数 | 188 | 188 |
| 每帧渲染三角面数 | 710,269 | 710,269 |

这些数值来自本次自动拖动采样，实际屏幕刷新率和设备会影响最终帧率。联调时需同时合入 `package.json` 和 `package-lock.json`，运行 `npm ci` 安装新增的 `three-mesh-bvh@0.9.18`。

加入白色展厅、768×512 地面倒影并开启雨刮后，同机同视口再次连续拖动约 5 秒，平均帧间隔 7.27 ms，第 95 百分位 11.2 ms，单次射线最长 0.4 ms。该记录为无头硬件渲染采样，不等同于显示器实际帧率。阴影贴图仅在车门和箱盖变化时刷新，玻璃和雨刮动画不触发额外阴影更新。
