# Tactic Lab — 本地 CS2 战术复盘桌面版

Windows-only Electron MVP。它解析 `.dem`，以 demo tick 为统一时间轴，在真实地图雷达上查看双方位置、道具和回合事件；支持五人 POV 视频位置、四个战术 Step、绘图与本地项目保存。Mock 项目仅用于界面开发，**不包含真实第一视角**。

## 直接运行

1. 双击 `release/win-unpacked/Tactic Lab.exe`，或在项目根目录执行 `npm install`、`npm start`。
2. 点击 **Open Demo** 导入 `.dem`；导入会生成本地 `project.json`、`match.json`、`frames.json`。打包版默认写入「文档/Tactic Lab」，开发版写入 `projects/`。
3. 选择五人队伍，用左侧 **2D** 查看战术地图；四个 Step 可分别 Capture、绘图、保存。文件夹图标可重新打开项目。
4. **Prepare POVs** 仅用于真实 DEMO。先在设置中检查 CS2、HLAE、FFmpeg、FFprobe 路径以及输出目录；关闭已有 CS2，并只在离线 demo 环境中启动。队列逐个录制五位选手，保存生成的命令、cfg、脚本与日志到项目的 `generated/`。成功时输出含游戏音频的 MP4 和 360p 静音预览。

可用快捷键：`1`–`5` 切 POV，`6` 或 `M` 切 2D，空格播放/暂停，方向键跳转，Shift+方向键大幅跳转。同步以 `currentTick` 为准，不以任意视频的起始时间猜测位置。

## 开发与打包

```powershell
npm install
npm run dev
npm test
npm run build
npm run test:e2e
npm run package
```

`npm run package` 生成 `release/win-unpacked/Tactic Lab.exe`。`npm run release` 生成 `release/Tactic Lab 0.1.0.exe` 便携版；构建不会自动发布到网络。真实 DEMO 集成测试：

```powershell
npm run test:demo -- 'D:/path/to/match.dem'
$env:TACTICLAB_TEST_DEMO='D:/path/to/match.dem'
npm run test:e2e
```

E2E 在设置了 `TACTICLAB_TEST_DEMO` 时会打开 `artifacts/integration/project.json` 并重新导入 DEMO，因此先运行 `test:demo`。无需 DEMO 时为 UI/IPC smoke test。

## HLAE / FFmpeg

- 设置页可手动选择各可执行文件；常见 Steam 库、随包 HLAE 和 FFmpeg 会自动探测。
- 本仓库随包放置官方 HLAE 2.192.2 与 FFmpeg/FFprobe。HLAE 录制需要 `HLAE.exe`、`x64/AfxHookSource2.dll`、`ffmpeg/bin/ffmpeg.exe` 和 `resources/AfxHookSource2/snippets` 保持原有目录关系。
- 录制逻辑在 `src/hlae/generator.ts`、`src/hlae/manager.ts`；采集后核对开始/结束 tick、视频时长和音频轨，失败时不把视频标为已验证。
- 外部依赖与 CS2 版本须相容。CS2 更新经常使 Source2 hook 地址失效；遇到 `Could not find address for pattern`，需等待或安装与当前 CS2 兼容的官方 HLAE 版本。参考 [AdvancedFX FAQ](https://github.com/advancedfx/advancedfx/wiki/FAQ)。不要通过关闭安全机制或在在线对局中尝试录制。

## 实际验收状态（2026-09-23）

在本机 `de_dust2` 实际 DEMO 上：10 位玩家、两支五人队伍、19 回合、28,490 个采样帧、734 个事件、347 个道具事件解析成功；四个 Step 保存和重开成功。单元测试 10/10 通过，Electron 开发版端到端测试通过。详见 `artifacts/integration/report.json` 与 `artifacts/electron-smoke.json`。

**真实 POV 尚未通过验收。** 本机 CS2 版本 1.41.8.2（2026-09-22）运行 HLAE 2.192.2 时，`AfxHookSource2` 报地址模式找不到。已实际启动 HLAE/CS2 并记录失败日志；队列现在会在首个作业失败后取消余下四个作业，但没有生成带声音的真实 POV。因此“约 95% 相同”、五路真实 POV 和真实切换误差 ≤100 ms **均不能宣称达成**。代码有五路录制、音频校验和同步管线，但须在兼容的 HLAE/CS2 组合上端到端验证。

地图概览为 Valve 游戏素材，仅供本地个人/战队复盘使用；本项目不是 cs2.cam 产品，也未复制其商标。
