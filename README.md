# ClaudeDeck

> Claude Code 的本地控制台 —— **会话监控 + 完成通知 + 记忆可视化**三合一桌面应用。

把散落在 `~/.claude/` 里的状态，变成一块可视化的「驾驶舱」。数据源全部来自本机 `~/.claude/`，无需逆向、无需 hack。

## 功能

- 📡 **会话监控** ✅ — 实时显示哪些 Claude Code 会话在运行 / 空闲 / 等待输入 / 疑似卡死，跑在哪个项目、用了多久。
- 🔔 **完成通知** ✅ — 长任务跑完或需要授权时，**桌面弹窗 + 声音**提醒（可设阈值，过滤短问答）。
- 📱 **手机推送** ✅ — 应用内**一键安装** Claude Code hook，把「任务完成 / 等待授权」推到手机（**Bark / iPhone**），**应用不用开着也能收到**。
- 🧠 **记忆可视化** 🚧 — 统一面板查看 / 编辑全局 + 项目级记忆（CLAUDE.md、auto-memory），按 frontmatter 分类、`[[name]]` 渲染成关系图。开发中。

## 平台

目前仅在 **Windows 11** 实测。macOS / Linux 理论可用（Tauri 跨平台），但 `~/.claude/` 路径编码规则尚未在这两个平台验证。

## 下载使用（免安装）

到 [Releases](https://github.com/XueTianyu24/ClaudeDeck/releases) 下载 **`ClaudeDeck.exe`**，**Windows 11 双击即用**，免安装、免配置。

- 首次运行被 Windows SmartScreen 拦截是未签名应用的正常现象 → 点「更多信息」→「仍要运行」。
- 依赖 WebView2 运行时（Win11 自带，无需额外安装）。
- 想要安装版（进开始菜单、可卸载）：下载 `ClaudeDeck_*_x64-setup.exe`。

## 从源码运行（开发）

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install)（Tauri 后端，首次编译较久）
- Windows 需 WebView2（Win11 自带）+ MSVC 构建工具

### 开发模式

```bash
npm install
npm run tauri dev        # 启动桌面开发模式，首次编译 Rust 请耐心等
```

### 打包

```bash
npm run tauri build      # 免安装 exe: src-tauri/target/release/ClaudeDeck.exe；安装包: target/release/bundle/
```

## 使用

启动后窗口会列出当前所有 Claude Code 会话（读 `~/.claude/sessions/*.json`，3 秒刷新）：状态、项目、PID、运行时长、最后心跳、版本。点右上角 🔔 配置通知（完成阈值、等待提醒、静音、提示音时长），右上角 ☀/☾ 切换深浅色主题。

## 手机推送配置（Bark / iPhone）

让 Claude Code 任务完成时推送到手机，**不依赖本应用常驻**——靠 Claude Code 原生 hook 在会话进程内触发。

**最简单**：打开应用 → 右上角 🔔 →「📱 手机推送(Bark)」卡片，填入 Bark key → 点「安装」即可（自动写好脚本和 settings.json，可一键卸载）。以下手动步骤供不用本应用、或想自行配置时参考。

1. **装 Bark**：iPhone App Store 搜 [Bark](https://github.com/Finb/Bark)，打开后首页有你的专属地址 `https://api.day.app/<你的KEY>/`，记下 `<你的KEY>`。
2. **放脚本**：把本仓库的 [`hooks/claudedeck-bark-notify.ps1`](hooks/claudedeck-bark-notify.ps1) 复制到 `~/.claude/hooks/`，把里面 `PUT_YOUR_BARK_KEY_HERE` 改成你的 KEY。
   - ⚠️ 该文件**必须保存为 UTF-8 with BOM**，否则 Windows PowerShell 5.1 读中文会乱码。
3. **挂 hook**：把下面片段合并进 `~/.claude/settings.json` 的顶层（改前先备份）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/你的用户名/.claude/hooks/claudedeck-bark-notify.ps1", "timeout": 10 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/你的用户名/.claude/hooks/claudedeck-bark-notify.ps1", "timeout": 10 } ] }
    ],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [ { "type": "command", "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/Users/你的用户名/.claude/hooks/claudedeck-bark-notify.ps1", "timeout": 10 } ] }
    ]
  }
}
```

4. **新开一个 Claude Code 会话**让 hook 生效，派个 ≥30 秒的活试试。

工作原理：`UserPromptSubmit` 记本轮起点 → `Stop` 算时长，满 30 秒（阈值，过滤短问答）才推「✅ 任务完成 / 用时」→ `Notification` 在 Claude 卡着等授权时推「⏳ 需要你处理」。想换 ntfy（Android / 自建）或微信推送，改脚本里的 curl 目标即可。

## 架构

- **Tauri 2 + React + TypeScript + Vite**：Rust 后端读 `~/.claude/`、常驻线程检测会话状态翻转、发系统通知；前端做面板与可视化。
- 包体小、内存低、原生系统通知 + 本地文件访问无浏览器沙箱限制。

> ⚠️ Claude Code 的 `sessions/*.json`、`*.jsonl` 是内部私有格式、随版本漂移，无官方契约。本项目全字段容错解析 + 失败降级，但不保证对所有版本永远适配。

## 路线图

- [x] 手机推送 GUI 一键安装 / 卸载（应用内填 Bark key，自动写脚本 + settings.json）
- [ ] 手机推送多渠道（ntfy / 微信）选择 + 阈值可调 UI
- [ ] 记忆可视化面板（CLAUDE.md + auto-memory + 关系图）
- [ ] 会话行展开看最近消息
- [ ] macOS / Linux 路径编码适配

## 许可

[MIT](LICENSE) © 2026 雪天鱼
