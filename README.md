# ClaudeDeck

> Claude Code 的本地控制台 —— **记忆可视化 + 会话监控 + 完成通知**三合一桌面应用。

把散落在 `~/.claude/` 里的状态变成一块可视化的"驾驶舱"：

- 🧠 **记忆可视化** — 统一面板查看/编辑全局 + 项目级记忆（CLAUDE.md、auto-memory），按 frontmatter 分类，`[[name]]` 渲染成关系图。
- 📡 **会话监控** — 实时显示哪些 Claude Code 会话在运行 / 空闲 / 卡死，跑在哪个项目。
- 🔔 **完成通知** — 会话跑完或需要输入时系统弹窗 + 声音提醒（基于 Claude Code 原生 Stop / Notification hook）。

## 定位

别人是"会话查看器"，ClaudeDeck 是"记忆 + 会话状态 + 告警"的控制台。会话历史浏览已有成熟方案，我们只做监控所需的最小会话视图，**主打没人做透的记忆可视化管理**。

## 技术栈

- **Tauri 2 + React + TypeScript + Vite**。Rust 后端读 `~/.claude/`、文件监听、写 hook；前端做面板与可视化。
- 包体小、内存低、原生系统通知 + 本地文件监听无浏览器沙箱限制。
- 数据源全部来自本机 `~/.claude/`，无需逆向、无需 hack。

## 开发

```bash
npm install
npm run tauri dev      # 启动桌面开发模式
```

## 状态

🚧 脚手架已搭好，功能开发中。完整调研见 [`RESEARCH.md`](RESEARCH.md)，文档分层见 `CLAUDE.md` / `memory.md` / `.knowledge/`。
