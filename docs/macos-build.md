# 在 macOS 上构建 ClaudeDeck

ClaudeDeck 的数据源（`~/.claude/`）与核心功能跨平台通用。Windows 专属部分（toast AUMID、PowerShell hook、终端拉起方式）已按平台分支适配，macOS 下走对应实现。Mac 版需在 **Mac 本机**编译（Tauri 不支持从 Windows 交叉打包出 `.app`）。

## 一、环境准备

```bash
# 1. Xcode 命令行工具（提供 clang / cc，编译部分原生依赖必需）
xcode-select --install

# 2. Rust（已装可跳过）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 3. Node.js 18+（推荐用官方安装包或 nvm）
node -v   # 确认 ≥ 18
```

`curl`、`perl` 为 macOS 自带，手机推送 hook 依赖它们，无需额外安装。

## 二、构建

```bash
git clone https://github.com/XueTianyu24/ClaudeDeck.git
cd ClaudeDeck
npm install
npm run tauri build
```

产物：

- `src-tauri/target/release/bundle/dmg/ClaudeDeck_<版本>_aarch64.dmg`（Apple 芯片）或 `_x64.dmg`（Intel）
- `src-tauri/target/release/bundle/macos/ClaudeDeck.app`

开发调试：`npm run tauri dev`。

## 三、首次打开（Gatekeeper）

未签名 / 未公证的 app，首次打开 macOS 会拦截：

- **右键点 app → 打开**，在弹窗里再点「打开」即可；或
- 系统设置 → 隐私与安全性 → 「仍要打开」。

通知首次触发时，系统会请求通知权限，点允许。

## 四、平台差异说明

| 能力 | Windows | macOS |
|---|---|---|
| 启动器拉起终端 | `cmd /k` 或 `powershell -NoExit` | Terminal.app（osascript `do script`） |
| 手机推送 hook 脚本 | PowerShell `.ps1` | bash `.sh`（curl + perl，无 jq 依赖） |
| 桌面通知来源名 | AUMID 快捷方式兜底 | 系统原生，无需处理 |
| 打开 skill 目录 | 资源管理器 | Finder（`open`） |
| 启动器配置目录 | `%APPDATA%\ClaudeDeck` | `~/Library/Application Support/ClaudeDeck` |

## 五、实测状态（Apple Silicon / macOS 26）

已在 M 系 Mac 本机实测通过：

- ✅ `cargo build` / `npm run tauri dev` 编译启动无报错、无 panic（仅需 CLT + rustup，详见第一节）。
- ✅ 会话监控列表、记忆 / 技能 / 用量三视图正常；记忆项目名从会话 `cwd` 解析为友好名（不再是编码后的 `-Users-…-` 长串）。
- ✅ 启动器点「启动」→ 弹「控制『终端』」自动化授权 → Terminal.app 新窗口 `cd` 到目录起 claude；勾选 bash 代理前置命令（多行 export）也正常，不再触发 AppleScript 换行语法错。
- ✅ 桌面通知实测有效：「⏳ 等待你的输入」与「✅ 任务完成（带用时）」均主动弹出，完成通知伴 Web Audio 提示音。前提是首次在「系统设置 → 通知 → ClaudeDeck」授权，并把「提醒样式」设为「横幅」或「提醒」（默认可能只进通知中心、不主动弹）。

待用户按需实测：手机推送 hook（Bark / PushPlus）一键安装与真机收推。如遇问题请反馈。
