# 更新日志

本项目所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-06-06

### 新增
- **记忆可视化面板**（只读浏览）：「会话监控 / 记忆」标签切换；左侧项目栏（含全局 CLAUDE.md）；记忆按「用户画像 / 反馈偏好 / 项目状态 / 外部参考」分类成卡片；点击卡片展开完整正文；`[[关联]]` 链接点击高亮跳转。
- **Markdown 渲染**：全局 CLAUDE.md 与记忆正文以 Markdown 渲染（标题 / 列表 / 代码 / 表格 / 引用，支持 GFM）。
- **错误边界**：界面渲染异常时显示可恢复的降级页，不再整窗白屏。
- **运行环境探测**：未检测到 `~/.claude` 时给出友好提示，区分「没装 Claude Code」与「装了但没在跑会话」；缺少 `curl.exe` 时在手机推送区警告。

### 变更
- Cargo 包名由脚手架默认的 `tauri-app` 改为 `claudedeck`。

## [0.1.0] - 2026-06-06

### 新增
- **会话监控**：实时列出运行中的 Claude Code 会话（状态 / 项目 / PID / 运行时长 / 版本），疑似卡死判定。
- **桌面完成通知**：后端常驻线程检测「任务完成 / 等待输入」状态翻转，发系统弹窗 + 循环提示音（webview 切后台也不漏发）。
- **手机推送**：GUI 一键安装 Bark hook（iPhone），应用不开着也能收到通知。
- **免安装单 exe**：Windows 11 双击即用；注册 AUMID，纯净机也能正常弹 toast。
- 全新 app 图标与应用内 logo。

[0.2.0]: https://github.com/XueTianyu24/ClaudeDeck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/XueTianyu24/ClaudeDeck/releases/tag/v0.1.0
