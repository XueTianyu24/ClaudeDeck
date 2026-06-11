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

## 五、已知待验证项

macOS 适配代码无法在 Windows 上交叉编译验证，首次在 Mac 上 build 时如遇编译错误或运行问题，请反馈，会快速修。重点验证：会话监控刷新、桌面通知 + 提示音、记忆 / 技能 / 用量三视图、启动器开 Terminal、手机推送一键安装与实际收推。
