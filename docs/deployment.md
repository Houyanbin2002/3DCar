# GitHub Pages 发布与演示视频

## 发布内容

- 仓库：[Houyanbin2002/3DCar](https://github.com/Houyanbin2002/3DCar)。
- 在线展厅：<https://houyanbin2002.github.io/3DCar/>。
- 线上仅发布静态 3D 展厅、点击控制和演示视频区域，不部署语音及模型接口，不请求麦克风。
- 本地源码保留完整语音及模型功能。完整演示视频已上传，页面可直接播放。

## 自动部署

[Pages 工作流](../.github/workflows/pages.yml) 在推送到 `main` 时运行：安装依赖、执行车辆 / 语音 / 接口测试、构建并发布。Pull Request 只检查和构建，不部署。也可从 Actions 手动运行。

| 配置 | 值 |
| --- | --- |
| Node.js | 22.x |
| `PAGES_BASE` | `/3DCar/`，工作流根据仓库名生成 |
| `VITE_DEMO_MODE` | `showcase` |
| `VITE_DEMO_VIDEO_URL` | 可覆盖视频地址，未配置时使用 `videos/demo.mp4` |
| 产物 | `dist/`，含 GLB、贴图及许可 |

仓库 Settings → Pages 的发布来源设为 **GitHub Actions**。部署只使用仓库自带的短期令牌，不需要存放模型 Key。

## 演示视频与后续替换

当前视频为 [public/videos/demo.mp4](../public/videos/demo.mp4)，原文件直接上传，H.264 / AAC 编码，2560×1230，时长约 3 分 22 秒，约 12.7 MB。README 有观看链接，展厅右侧有播放器和新窗口观看入口。

可直接访问 <https://houyanbin2002.github.io/3DCar/videos/demo.mp4>。

替换视频可直接更新仓库内文件，推送到 `main` 后自动发布；也可改用外部地址：

1. 将视频上传到可公开访问的位置，例如 GitHub Issue / Release 附件或已有视频平台，无需将大视频加入 Git 历史。
2. 打开仓库 **Settings → Secrets and variables → Actions → Variables**，新增仓库变量 `VITE_DEMO_VIDEO_URL`。
3. 以 `.mp4`、`.webm`、`.ogg` 结尾的直接资源地址显示内嵌播放器；其他 HTTP / HTTPS 视频页面地址显示「观看演示视频」入口。
4. 在 **Actions → Build and deploy GitHub Pages → Run workflow** 重新发布，或推送代码触发构建。
5. 将视频链接补到 [README 的演示视频区](../README.md#演示视频)。GitHub 附件地址可直接粘贴进 README。

建议内容：拖转观察 → 点击车窗 → 唤醒控车 → 模糊表达追问 → 修改为全部降窗 → 直接说「那你帮我升起吧」→ 20 秒免唤醒连续操作。

仓库内的视频可放在 `public/videos/`，变量填 `videos/demo.mp4`，页面会根据站点子路径解析。较大视频优先使用附件或视频平台。

## 本地预览线上版本

PowerShell：

```powershell
$env:PAGES_BASE = '/3DCar/'
$env:VITE_DEMO_MODE = 'showcase'
npm run build
npm run preview -- --host 127.0.0.1 --port 5189
```

访问 `http://127.0.0.1:5189/3DCar/`。设置 `VITE_DEMO_VIDEO_URL` 可验证真实视频。

回到本地完整版，在同一终端清除展示版变量并重启：

```powershell
Remove-Item Env:VITE_DEMO_MODE -ErrorAction SilentlyContinue
Remove-Item Env:PAGES_BASE -ErrorAction SilentlyContinue
npm run dev
```

本地完整语音按 [服务端说明](../server/README.md) 配置，实际密钥文件保持在 Git 忽略范围内。

## 发布验证

2026-11-04 已通过 `/3DCar/` 子路径的展示版生产构建。Chrome 浏览器实测十部件开合、车窗轻点与长按、松手停止、反向控制、批量门窗、雨刮归位、热点、直接拾取、拖拽缩放及重置均通过，无未捕获异常。页面显示语音视频占位，未显示麦克风开启按钮。

README 首段下方使用项目方提供的本地完整版展示图；实际线上版以视频区域替代本地语音入口。
