use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_autostart::ManagerExt;

mod aumid;
mod usage;

/// busy 会话超过这个空闲时长（毫秒）判为疑似卡死。RESEARCH §3 初值。
const STUCK_THRESHOLD_MS: i64 = 60_000;
/// 后端通知线程的轮询间隔。不受 webview 前后台限流影响。
const NOTIFY_POLL_MS: u64 = 2_000;

/// 原始 sessions/<pid>.json 反序列化结构。
///
/// **全字段 optional**：CC 私有格式随版本漂移（本机已见 2.1.163/165 并存），
/// 缺字段不能让整条记录解析失败。见 RESEARCH §7 风险 1。
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawSession {
    pid: Option<u32>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    status: Option<String>,
    #[serde(rename = "startedAt")]
    started_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<i64>,
    version: Option<String>,
    kind: Option<String>,
    entrypoint: Option<String>,
}

/// 给前端渲染的会话视图（原始字段 + 派生字段）。
#[derive(Debug, Clone, Serialize)]
struct SessionView {
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<String>,
    project: Option<String>,
    status: Option<String>,
    version: Option<String>,
    kind: Option<String>,
    entrypoint: Option<String>,
    started_at: Option<i64>,
    updated_at: Option<i64>,
    running_ms: Option<i64>,
    idle_ms: Option<i64>,
    alive: bool,
    stuck: bool,
    parse_error: Option<String>,
    file: String,
}

/// 通知配置，由前端通过 `set_notify_config` 推送。
#[derive(Debug, Clone, Deserialize)]
struct NotifyConfig {
    enabled: bool,
    done: bool,        // 长任务完成（busy/shell → idle）
    waiting: bool,     // 等待输入（→ waiting）
    threshold_ms: i64, // 完成通知的最小 busy 时长
}

impl Default for NotifyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            done: true,
            waiting: true,
            threshold_ms: 30_000,
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("sessions"))
}

/// 从 cwd 反推项目名（取最后一段路径），兼容 Win `\` 与 Unix `/`。
fn project_from_cwd(cwd: &str) -> Option<String> {
    cwd.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn fmt_dur(ms: i64) -> String {
    let s = ms / 1000;
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 {
        return format!("{}m{}s", m, s % 60);
    }
    let h = m / 60;
    if h < 24 {
        return format!("{}h{}m", h, m % 60);
    }
    format!("{}d{}h", h / 24, h % 24)
}

fn error_view(file: String, msg: String) -> SessionView {
    SessionView {
        pid: None,
        session_id: None,
        cwd: None,
        project: None,
        status: None,
        version: None,
        kind: None,
        entrypoint: None,
        started_at: None,
        updated_at: None,
        running_ms: None,
        idle_ms: None,
        alive: false,
        stuck: false,
        parse_error: Some(msg),
        file,
    }
}

fn busy_rank(status: &Option<String>) -> u8 {
    match status.as_deref() {
        Some("busy") => 2,
        Some("idle") => 1,
        _ => 0,
    }
}

/// 读取 `~/.claude/sessions/*.json`，解析为会话列表（解析失败的单文件降级）。
fn read_session_views() -> Result<Vec<SessionView>, String> {
    let dir = sessions_dir().ok_or("无法定位 ~/.claude/sessions 目录")?;
    let mut out: Vec<SessionView> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }

    let now = now_ms();

    // 解析与判活拆成两遍：判活只需"进程是否存在"，故只刷会话声明的那几个 pid，
    // 而非 System::new_all() 全量刷新 CPU/内存/磁盘/网络/全部进程命令行。
    // 这条路径被前端 3s 轮询 + 后端通知线程 2s 轮询共用，全量刷新会持续吃 CPU、拖慢首屏。
    // 第一遍：读取 + 解析全部 json（解析失败就地降级，绝不让坏文件拖垮整页）。
    let mut parsed: Vec<Result<(String, RawSession), SessionView>> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取 sessions 目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let file = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                parsed.push(Err(error_view(file, format!("读文件失败: {e}"))));
                continue;
            }
        };

        match serde_json::from_str::<RawSession>(&content) {
            Ok(raw) => parsed.push(Ok((file, raw))),
            Err(e) => parsed.push(Err(error_view(file, format!("JSON 解析失败: {e}")))),
        }
    }

    // 只刷新这些会话声明的 pid（RESEARCH §7 风险 5：文件残留但进程已死）。
    // remove_dead=true + ProcessRefreshKind::nothing()：不存在的 pid 不会进表，据此判活。
    let pids: Vec<Pid> = parsed
        .iter()
        .filter_map(|p| p.as_ref().ok().and_then(|(_, raw)| raw.pid).map(Pid::from_u32))
        .collect();
    let mut sys = System::new();
    if !pids.is_empty() {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing(),
        );
    }

    // 第二遍：构建视图（判活查上面精刷过的进程表）。
    for item in parsed {
        match item {
            Err(v) => out.push(v),
            Ok((file, raw)) => {
                let alive = raw
                    .pid
                    .map(|p| sys.process(Pid::from_u32(p)).is_some())
                    .unwrap_or(false);
                let running_ms = raw.started_at.map(|s| now - s);
                let idle_ms = raw.updated_at.map(|u| now - u);
                let is_busy = raw.status.as_deref() == Some("busy");
                let stuck = is_busy && idle_ms.map(|i| i > STUCK_THRESHOLD_MS).unwrap_or(false);
                let project = raw.cwd.as_deref().and_then(project_from_cwd);

                out.push(SessionView {
                    pid: raw.pid,
                    session_id: raw.session_id,
                    cwd: raw.cwd,
                    project,
                    status: raw.status,
                    version: raw.version,
                    kind: raw.kind,
                    entrypoint: raw.entrypoint,
                    started_at: raw.started_at,
                    updated_at: raw.updated_at,
                    running_ms,
                    idle_ms,
                    alive,
                    stuck,
                    parse_error: None,
                    file,
                });
            }
        }
    }

    // 排序：活着的优先 → busy 优先 → 最近更新优先。
    out.sort_by(|a, b| {
        b.alive
            .cmp(&a.alive)
            .then_with(|| busy_rank(&b.status).cmp(&busy_rank(&a.status)))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });

    Ok(out)
}

#[tauri::command]
fn list_sessions() -> Result<Vec<SessionView>, String> {
    read_session_views()
}

/// 运行环境探测：用于前端区分「没装 CC」「装了没跑会话」，及 curl 可用性。
#[derive(Debug, Serialize)]
struct EnvStatus {
    /// 能否定位到 home 目录（极端情况下 dirs 也可能拿不到）
    home_found: bool,
    /// `~/.claude` 是否存在（不存在 ≈ 没装/没跑过 Claude Code）
    claude_dir_exists: bool,
    /// `~/.claude/sessions` 是否存在（存在但空 = 装了但当前无会话）
    sessions_dir_exists: bool,
    /// `curl.exe` 是否可用（手机推送 hook 依赖它；老 Win10 可能缺）
    curl_available: bool,
}

/// curl 可执行名：Windows 用 `curl.exe`，macOS / Linux 自带 `curl`。
#[cfg(windows)]
const CURL_BIN: &str = "curl.exe";
#[cfg(not(windows))]
const CURL_BIN: &str = "curl";

/// 创建一个不弹控制台黑窗的 Command（Windows 上 GUI 进程 spawn 控制台子进程默认会闪一下黑窗）。
/// 仅用于内部静默调用（curl 探测 / 推送）；launcher 启动 claude 是故意要终端窗口的，不走这里。
#[allow(unused_mut)]
fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// 检测 curl 是否在 PATH 中可用（手机推送依赖；macOS / Linux 一般自带）。
fn curl_available() -> bool {
    silent_command(CURL_BIN)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 当前操作系统标识：`windows` / `macos` / `linux`（前端按平台分支 UI / 默认命令用）。
#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn get_env_status() -> EnvStatus {
    let home = dirs::home_dir();
    let claude = home.as_ref().map(|h| h.join(".claude"));
    let sessions = claude.as_ref().map(|c| c.join("sessions"));
    EnvStatus {
        home_found: home.is_some(),
        claude_dir_exists: claude.map(|c| c.exists()).unwrap_or(false),
        sessions_dir_exists: sessions.map(|s| s.exists()).unwrap_or(false),
        curl_available: curl_available(),
    }
}

// ── 检查更新（轻量提示式）────────────────────────────────────────
//
// Tier 1 方案：查 GitHub Release 最新版本号，比当前新就让前端弹「打开下载页」提示。
// 不走 tauri-plugin-updater 原地自动安装（便携版 exe 不支持），便携版 + 安装版 + mac 全覆盖。
// 复用项目已有的 curl 调用（silent_command，Windows 无黑窗）；GitHub API 默认 UA 即可，
// 加 --max-time 防启动检查卡住。releases/latest 自动排除 draft / prerelease。

/// 开源仓库的 GitHub API 入口（owner/repo 写死，发版地址固定）。
const RELEASE_API: &str =
    "https://api.github.com/repos/XueTianyu24/ClaudeDeck/releases/latest";

#[derive(Debug, Serialize)]
struct UpdateInfo {
    /// 当前运行版本（来自 Cargo.toml，编译期注入）
    current: String,
    /// GitHub 最新 release 版本（已剥 `v` 前缀）
    latest: String,
    /// latest 是否比 current 新
    has_update: bool,
    /// release 说明正文（markdown，前端渲染「查看更新内容」用）
    notes: String,
    /// release 页面 URL（前端「打开下载页」用）
    url: String,
    /// 发布时间（ISO8601）
    published_at: String,
    /// Windows 安装包（`-setup.exe`）直链；无则 None（一键下载安装用）
    installer_url: Option<String>,
    /// 安装包文件名（落盘临时文件名用）
    installer_name: Option<String>,
    /// 安装包字节大小（进度条算百分比用；未知为 0）
    installer_size: u64,
}

/// 朴素版本号比较：`a > b` 返回 true。按 `.` 分段比较数字部分，缺位补 0，
/// 容忍 `1.2.3-beta` 这类后缀（只取每段前导数字）。版本号都是 `x.y.z` 形态，够用。
fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| {
                let num: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
                num.parse().unwrap_or(0)
            })
            .collect()
    };
    let va = parse(a);
    let vb = parse(b);
    let n = va.len().max(vb.len());
    for i in 0..n {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

#[tauri::command]
fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let out = silent_command(CURL_BIN)
        .args([
            "-fsSL",
            "--max-time",
            "8",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: ClaudeDeck",
            RELEASE_API,
        ])
        .output()
        .map_err(|e| format!("调用 curl 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "检查更新失败（网络或 GitHub 限流）: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 GitHub 响应失败: {e}"))?;
    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if tag.is_empty() {
        return Err("GitHub 未返回 tag_name（可能尚无 release）".into());
    }
    let latest = tag.trim_start_matches('v').to_string();
    let notes = json
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/XueTianyu24/ClaudeDeck/releases/latest")
        .to_string();
    let published_at = json
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 找 Windows 安装包资产（NSIS `-setup.exe`），供「一键下载安装」用。
    let mut installer_url = None;
    let mut installer_name = None;
    let mut installer_size = 0u64;
    if let Some(assets) = json.get("assets").and_then(|v| v.as_array()) {
        if let Some(a) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n.ends_with("-setup.exe"))
                .unwrap_or(false)
        }) {
            installer_url = a
                .get("browser_download_url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            installer_name = a
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            installer_size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        }
    }
    let has_update = version_gt(&latest, &current);
    Ok(UpdateInfo {
        current,
        latest,
        has_update,
        notes,
        url,
        published_at,
        installer_url,
        installer_name,
        installer_size,
    })
}

// ── 自动更新：官方 tauri-plugin-updater（v0.10.0 起）───────────────
// 检查/下载/安装走官方插件（latest.json + minisign 签名验证），前端见 UpdateModal.tsx。
// v0.9.12 的 curl 自实现下载器已退役；check_for_update 保留作兜底（插件检查失败时
// 退回「打开下载页」）。下面是 relaunch 兜底（参考 claude-code-history-viewer）。

/// 强退当前进程并由游离辅助进程拉起新版。
///
/// 官方 `relaunch()` 在 macOS 有已知上游 bug（tauri#13923/#11392/#8472）：下载安装成功
/// 但重启步骤失败，用户困在旧二进制上。辅助进程**必须等父进程完全退出**再拉起——
/// 否则 single-instance 插件会把新进程当重复启动、唤回旧窗口，更新不生效。
#[tauri::command]
fn force_quit_and_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    let current_exe =
        std::env::current_exe().map_err(|e| format!("获取当前程序路径失败: {e}"))?;
    let ppid = std::process::id();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // 用 PowerShell Wait-Process 等父进程退出再 Start-Process。不用 `cmd /C start`：
        // cmd 在双引号内也做 %VAR% 展开，路径含字面 `%` 会被破坏。
        let exe_ps = current_exe.to_string_lossy().replace('\'', "''");
        let ps_cmd = format!(
            "Wait-Process -Id {ppid} -ErrorAction SilentlyContinue -Timeout 30; \
             Start-Sleep -Milliseconds 300; \
             Start-Process -FilePath '{exe_ps}'"
        );
        Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps_cmd])
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动重启辅助进程失败: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        // 找 .app bundle 根，等父进程退出后 open -n 重开。
        let app_bundle = current_exe
            .ancestors()
            .find(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
            .ok_or_else(|| "未找到 .app bundle".to_string())?;
        let bundle_escaped = format!("'{}'", app_bundle.to_string_lossy().replace('\'', "'\\''"));
        let cmd = format!(
            "i=0; while kill -0 {ppid} 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; sleep 0.3; open -n {bundle_escaped}"
        );
        Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动重启辅助进程失败: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let exe_escaped = format!("'{}'", current_exe.to_string_lossy().replace('\'', "'\\''"));
        let cmd = format!(
            "i=0; while kill -0 {ppid} 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; sleep 0.3; setsid {exe_escaped} >/dev/null 2>&1 < /dev/null &"
        );
        Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动重启辅助进程失败: {e}"))?;
    }

    // 辅助进程已就位，稍等片刻让前端把「正在重启」状态画出来再退出。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        app.exit(0);
    });
    Ok(())
}

// ── 会话历史（最近会话浏览 + 内容入口）──────────────────────────
//
// 数据源：~/.claude/projects/<编码路径>/<sessionId>.jsonl（持久 transcript）。
// 与 list_sessions（运行中状态）互补：这里列「最近 / 历史」会话，关机后仍在，
// 解决多开会话「关机后忘了开过哪些、该去哪个目录重开、聊到哪了」。
// 性能：先按文件 mtime 排序、截到上限，只对入选会话**读头部找 cwd + 尾部找
// aiTitle/lastPrompt**，不全量解析大 jsonl。

#[derive(Debug, Serialize)]
struct RecentSession {
    session_id: String,
    /// jsonl 绝对路径（前端读详情用）
    file: String,
    /// 会话工作目录（来自 jsonl 的 cwd 字段；启动器联动用）
    cwd: Option<String>,
    /// 项目名（cwd 末段；无 cwd 时退回编码目录名）
    project: Option<String>,
    /// CC 自动生成的会话标题（aiTitle）
    title: Option<String>,
    /// 用户最后一次 prompt（标题缺失时前端兜底展示）
    last_prompt: Option<String>,
    /// 最后活跃时间（文件 mtime，unix ms）
    last_active_ms: i64,
    /// jsonl 文件大小（字节）
    size_bytes: u64,
    /// 当前是否有活进程（交叉 sessions/*.json）
    running: bool,
}

/// 读文件前 n 行（找 cwd 用；cwd 在首个 user 事件，靠前）。
fn read_head_lines(path: &Path, n: usize) -> Vec<String> {
    match File::open(path) {
        Ok(f) => BufReader::new(f)
            .lines()
            .take(n)
            .map_while(Result::ok)
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// 读文件尾部约 n 字节并按行切（找 aiTitle/lastPrompt 用；它们靠后、不断更新）。
/// 丢弃首行（可能被从中间截断）。
fn read_tail_lines(path: &Path, n: u64) -> Vec<String> {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(n);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let mut lines: Vec<String> = String::from_utf8_lossy(&buf)
        .lines()
        .map(|s| s.to_string())
        .collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// 在若干 JSON 行里找首个带 cwd 的事件。
fn find_cwd(lines: &[String]) -> Option<String> {
    for ln in lines {
        if let Ok(v) = serde_json::from_str::<Value>(ln) {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    return Some(c.to_string());
                }
            }
        }
    }
    None
}

/// 在尾部 JSON 行里取最新的 aiTitle / lastPrompt（正序遍历、保留最后出现）。
fn find_title_prompt(lines: &[String]) -> (Option<String>, Option<String>) {
    let mut title = None;
    let mut prompt = None;
    for ln in lines {
        if let Ok(v) = serde_json::from_str::<Value>(ln) {
            if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                if !t.trim().is_empty() {
                    title = Some(t.trim().to_string());
                }
            }
            if let Some(p) = v.get("lastPrompt").and_then(|x| x.as_str()) {
                if !p.trim().is_empty() {
                    prompt = Some(p.trim().to_string());
                }
            }
        }
    }
    (title, prompt)
}

/// 由一个 jsonl 路径 + 文件元信息构建 RecentSession（读头部拿 cwd、尾部拿 aiTitle/lastPrompt）。
/// list_recent_sessions 与 search_sessions 共用。
fn build_recent_session(
    path: &Path,
    mt: i64,
    size: u64,
    running: &HashSet<String>,
) -> RecentSession {
    let head = read_head_lines(path, 40);
    let tail = read_tail_lines(path, 64 * 1024);
    let cwd = find_cwd(&head).or_else(|| find_cwd(&tail));
    let (title, last_prompt) = find_title_prompt(&tail);
    let session_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let project = cwd.as_deref().and_then(project_from_cwd).or_else(|| {
        path.parent()
            .and_then(|d| d.file_name())
            .map(|s| decode_project_label(s.to_string_lossy().as_ref()))
    });
    let is_running = running.contains(&session_id);
    RecentSession {
        session_id,
        file: path.to_string_lossy().to_string(),
        cwd,
        project,
        title,
        last_prompt,
        last_active_ms: mt,
        size_bytes: size,
        running: is_running,
    }
}

#[tauri::command]
fn list_recent_sessions(limit: Option<usize>) -> Result<Vec<RecentSession>, String> {
    let root = projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    // limit=0 表示不设上限（「按项目浏览」要一次列全）；每会话只读头尾小块，全量也轻。
    let cap = match limit.unwrap_or(40) {
        0 => usize::MAX,
        n => n,
    };

    // 运行中的 sessionId 集合 → 列表里标「运行中」并置顶。
    let running: HashSet<String> = read_session_views()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.alive)
        .filter_map(|s| s.session_id)
        .collect();

    // 收集所有 jsonl 的 (路径, mtime, 字节大小)。
    let mut files: Vec<(PathBuf, i64, u64)> = Vec::new();
    for proj in fs::read_dir(&root)
        .map_err(|e| format!("读取 projects 目录失败: {e}"))?
        .flatten()
    {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        if let Ok(rd) = fs::read_dir(&pdir) {
            for f in rd.flatten() {
                let p = f.path();
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let meta = f.metadata().ok();
                let mt = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                files.push((p, mt, size));
            }
        }
    }

    // 按最后活跃倒序，截到上限，只对入选者解析头尾。
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(cap);

    let mut out = Vec::new();
    for (path, mt, size) in files {
        out.push(build_recent_session(&path, mt, size, &running));
    }
    // 运行中置顶，其余维持 mtime 倒序。
    out.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| b.last_active_ms.cmp(&a.last_active_ms))
    });
    Ok(out)
}

/// 全文检索会话：扫指定时间范围内（按 mtime）所有 jsonl 的完整内容，大小写不敏感
/// 粗匹配关键词（整文件 contains，不逐行解析 JSON；命中后才解析头尾拿元数据）。
/// weeks = 时间范围周数（None / 0 = 全部，作性能旋钮）。结果按运行中置顶 + mtime 倒序，至多 80 条。
#[tauri::command]
fn search_sessions(query: String, weeks: Option<u32>) -> Result<Vec<RecentSession>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let root = projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    // 时间下限（ms）；weeks=None/0 = 不限。
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let cutoff_ms: i64 = match weeks {
        Some(w) if w > 0 => now_ms - (w as i64) * 7 * 24 * 3600 * 1000,
        _ => 0,
    };

    let running: HashSet<String> = read_session_views()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.alive)
        .filter_map(|s| s.session_id)
        .collect();

    let mut hits: Vec<RecentSession> = Vec::new();
    for proj in fs::read_dir(&root)
        .map_err(|e| format!("读取 projects 目录失败: {e}"))?
        .flatten()
    {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let rd = match fs::read_dir(&pdir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let meta = f.metadata().ok();
            let mt = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mt < cutoff_ms {
                continue;
            }
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let content = match fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            // 廉价预筛：整文件（含噪音）都不含关键词 → 直接跳过，不逐行解析。
            if !content.to_lowercase().contains(&q) {
                continue;
            }
            // 精确确认：只在「真实对话文本」里命中才算 —— 仅 user/assistant 消息，
            // 且经 extract_msg_text 只取 content 的 text 块（跳过工具调用/工具结果/思维链/
            // 各类元数据行）。这样避免整文件粗匹配把 JSON 结构、工具输出、文件内容当成命中。
            let mut matched = false;
            for line in content.lines() {
                let v = match serde_json::from_str::<Value>(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if t != "user" && t != "assistant" {
                    continue;
                }
                if extract_msg_text(v.get("message"))
                    .to_lowercase()
                    .contains(&q)
                {
                    matched = true;
                    break;
                }
            }
            if matched {
                hits.push(build_recent_session(&p, mt, size, &running));
            }
        }
    }

    hits.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| b.last_active_ms.cmp(&a.last_active_ms))
    });
    hits.truncate(80);
    Ok(hits)
}

/// 会话详情里的一条消息（只取真实对话文本，跳过工具往返）。
#[derive(Debug, Serialize)]
struct SessionMsg {
    role: String,
    text: String,
    timestamp: Option<String>,
}

/// 从 message.content 抽纯文本（字符串直接取；数组取 type=text 的 block）。
fn extract_msg_text(message: Option<&Value>) -> String {
    let m = match message {
        Some(m) => m,
        None => return String::new(),
    };
    match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            let mut out = String::new();
            for b in arr {
                if b.get("type").and_then(|x| x.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// 解析整个会话的真实对话消息（user/assistant 文本，跳过纯工具往返），按原顺序。
/// 路径校验防穿越。read_session_tail / read_session_full 共用。
fn parse_session_msgs(file: &str) -> Result<Vec<SessionMsg>, String> {
    let root = projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    let path = PathBuf::from(file);
    // 安全：必须落在 projects 目录内、且是 jsonl，挡路径穿越。
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") || !path.starts_with(&root) {
        return Err("非法的会话文件路径".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取会话失败: {e}"))?;

    let mut msgs: Vec<SessionMsg> = Vec::new();
    for ln in content.lines() {
        let v = match serde_json::from_str::<Value>(ln) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" {
            continue;
        }
        let text = extract_msg_text(v.get("message"));
        if text.trim().is_empty() {
            continue;
        }
        let timestamp = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        msgs.push(SessionMsg {
            role: t.to_string(),
            text,
            timestamp,
        });
    }
    Ok(msgs)
}

/// 读某会话尾部最近 max 条真实对话消息（快速预览用）。
#[tauri::command]
fn read_session_tail(file: String, max: Option<usize>) -> Result<Vec<SessionMsg>, String> {
    let n = max.unwrap_or(8).max(1);
    let mut msgs = parse_session_msgs(&file)?;
    let start = msgs.len().saturating_sub(n);
    Ok(msgs.split_off(start))
}

/// 读某会话的完整对话（全部 user/assistant 文本，按原顺序），供「查看全文」用。
#[tauri::command]
fn read_session_full(file: String) -> Result<Vec<SessionMsg>, String> {
    parse_session_msgs(&file)
}

/// 删除单个会话记录文件（jsonl）。物理删除、不可恢复，前端负责二次确认。
/// 安全：仅允许 projects 目录内的 .jsonl，挡路径穿越。
#[tauri::command]
fn delete_session(file: String) -> Result<(), String> {
    let root = projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    let path = PathBuf::from(&file);
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") || !path.starts_with(&root) {
        return Err("非法的会话文件路径".into());
    }
    if !path.exists() {
        return Err("会话文件不存在（可能已被删除）".into());
    }
    fs::remove_file(&path).map_err(|e| format!("删除会话失败: {e}"))?;
    Ok(())
}

// ── 记忆可视化 ────────────────────────────────────────────────
//
// 数据源：`~/.claude/projects/<编码路径>/memory/*.md`（auto-memory）。
// **两种 frontmatter 格式并存**（实地核实，本机 73 嵌套 / 81 顶层）：
//   A 顶层平铺：  type: feedback
//   B metadata 嵌套： metadata:\n  type: feedback\n  node_type: memory
// 解析全字段 optional，两处都探，单文件失败降级，绝不让一个坏文件拖垮整页。

/// 一个有 memory 目录的项目（给前端左侧切换）。
#[derive(Debug, Serialize)]
struct MemoryProject {
    /// 编码后的目录名（如 C--Users-jccao-Desktop-ClaudeDeck）
    dir: String,
    /// 友好显示名（尽力从编码反推，失败则显示编码名）
    label: String,
    /// 该项目 memory/*.md 数量（不含 MEMORY.md 索引）
    count: usize,
    /// 是否存在 MEMORY.md 索引文件
    has_index: bool,
}

/// 一条记忆卡片。
#[derive(Debug, Serialize)]
struct MemoryNode {
    file: String,
    name: Option<String>,
    description: Option<String>,
    /// feedback / user / project / reference / 其它
    mem_type: Option<String>,
    /// body 里 [[...]] 提取的关联（可能指向 name 或文件名）
    links: Vec<String>,
    /// 完整正文（去掉 frontmatter），前端折叠显示
    body: String,
    parse_error: Option<String>,
    /// 文件修改时间（ms），编辑保存时回传做 mtime 冲突检测
    mtime: i64,
    /// 原始完整内容（含 frontmatter），供编辑回写
    raw: String,
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// 从编码目录名尽力反推友好名：取最后一个常见容器目录（Desktop / Documents / …）
/// 之后的部分，否则原样。编码规则有歧义（`/`、`.`、`@` 等都被压成 `-`，项目名本身
/// 含 `-` 时无法可靠还原），故仅作**兜底**显示美化——优先用 `cwd_from_project_dir`
/// 读真实 cwd（权威、跨平台），这里只在读不到 jsonl 时用。
fn decode_project_label(dir: &str) -> String {
    // 跨平台：Win 路径含 `Desktop-` / `Documents-`，mac/Linux 同样常见这两个。
    for marker in [
        "Desktop-",
        "Documents-",
        "Projects-",
        "projects-",
        "repos-",
        "Code-",
        "code-",
        "src-",
    ] {
        if let Some(idx) = dir.rfind(marker) {
            let tail = &dir[idx + marker.len()..];
            if !tail.is_empty() {
                return tail.to_string();
            }
        }
    }
    dir.to_string()
}

/// 从项目目录里任一 transcript（`*.jsonl`）读出真实 `cwd`。
/// 这是**权威且跨平台**的项目名来源（编码目录名是有损的，无法可靠反推）——
/// `~/.claude/projects/<编码>/` 下既有会话 jsonl 也有 memory/，读 jsonl 头即可拿到原始路径。
fn cwd_from_project_dir(dir: &Path) -> Option<String> {
    let rd = fs::read_dir(dir).ok()?;
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            if let Some(c) = find_cwd(&read_head_lines(&p, 40)) {
                return Some(c);
            }
        }
    }
    None
}

/// 统计某 memory 目录下的记忆文件数（排除 MEMORY.md 索引）。
fn count_memory_files(memory_dir: &Path) -> usize {
    fs::read_dir(memory_dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    let p = e.path();
                    p.extension().and_then(|s| s.to_str()) == Some("md")
                        && p.file_name().and_then(|s| s.to_str()) != Some("MEMORY.md")
                })
                .count()
        })
        .unwrap_or(0)
}

#[tauri::command]
fn list_memory_projects() -> Result<Vec<MemoryProject>, String> {
    let root = projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    let entries = fs::read_dir(&root).map_err(|e| format!("读取 projects 目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let memory_dir = path.join("memory");
        if !memory_dir.exists() {
            continue;
        }
        let has_index = memory_dir.join("MEMORY.md").exists();
        let count = count_memory_files(&memory_dir);
        // count==0（空目录）也返回，供前端展示「索引 / 物理删除」；
        // 但完全空（无卡片且无 MEMORY.md）的残目录跳过，没有展示价值。
        if count == 0 && !has_index {
            continue;
        }
        let dir = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        // 优先读真实 cwd 取末段做友好名（跨平台、无歧义）；读不到再退回编码名兜底反推。
        let label = cwd_from_project_dir(&path)
            .as_deref()
            .and_then(project_from_cwd)
            .unwrap_or_else(|| decode_project_label(&dir));
        out.push(MemoryProject {
            dir,
            label,
            count,
            has_index,
        });
    }
    // 记忆多的项目排前面（空目录 count==0 自然沉底）
    out.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(out)
}

/// 去掉配对的首尾引号并反转义 `\"`。
fn unquote(s: &str) -> String {
    let t = s.trim();
    let inner = if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
        || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
    {
        &t[1..t.len() - 1]
    } else {
        t
    };
    inner.replace("\\\"", "\"").replace("\\n", "\n")
}

/// 提取 body 里所有 `[[...]]` 链接（手写扫描，不依赖 regex crate）。
fn extract_links(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find("[[") {
        let after = &rest[i + 2..];
        if let Some(j) = after.find("]]") {
            let link = after[..j].trim();
            if !link.is_empty() && !out.iter().any(|x| x == link) {
                out.push(link.to_string());
            }
            rest = &after[j + 2..];
        } else {
            break;
        }
    }
    out
}

/// 文件修改时间（毫秒）；取不到则 0。
fn file_mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 文件/目录创建时间（毫秒）；平台不支持或取不到则退回修改时间。
fn file_ctime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .filter(|&v| v > 0)
        .unwrap_or_else(|| file_mtime_ms(path))
}

/// 解析一个 memory .md：拆 frontmatter（兼容两种格式）+ 正文。
fn parse_memory(file: String, content: &str, mtime: i64) -> MemoryNode {
    // 不以 --- 开头：无 frontmatter，全是正文
    let mut name = None;
    let mut description = None;
    let mut mem_type = None;
    let mut body = content;

    if let Some(stripped) = content.strip_prefix("---") {
        // 找 frontmatter 的闭合 ---（在某一行单独出现）
        if let Some(end) = stripped.find("\n---") {
            let fm = &stripped[..end];
            // 闭合 --- 之后是正文
            let after = &stripped[end + 4..];
            body = after.strip_prefix('\n').unwrap_or(after);

            // 顶层字段不缩进，metadata 嵌套字段缩进；用 indented 区分即可，
            // type 在顶层（格式 A）或 metadata 内（格式 B）都接受。
            for raw_line in fm.lines() {
                let line = raw_line.trim_end();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let indented = line.starts_with(' ') || line.starts_with('\t');

                let Some((k, v)) = trimmed.split_once(':') else {
                    continue;
                };
                let key = k.trim();
                let val = v.trim();

                match key {
                    "name" if !indented => name = Some(unquote(val)),
                    "description" if !indented => description = Some(unquote(val)),
                    // type：顶层（A）或 metadata 嵌套（B）都接受，顶层优先
                    "type" if !val.is_empty() && (!indented || mem_type.is_none()) => {
                        mem_type = Some(unquote(val));
                    }
                    _ => {}
                }
            }
        }
    }

    MemoryNode {
        file,
        name,
        description,
        mem_type,
        links: extract_links(body),
        body: body.trim().to_string(),
        parse_error: None,
        mtime,
        raw: content.to_string(),
    }
}

/// 一篇文档型记忆（如全局 CLAUDE.md）的内容。
#[derive(Debug, Serialize)]
struct DocView {
    path: String,
    exists: bool,
    content: String,
    /// 修改时间（ms），编辑保存时回传做冲突检测
    mtime: i64,
}

fn global_md_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("CLAUDE.md"))
}

/// 读全局记忆载体 `~/.claude/CLAUDE.md`（规则文档，非卡片格式）。
#[tauri::command]
fn read_global_md() -> DocView {
    match global_md_path() {
        Some(p) => {
            let exists = p.exists();
            let content = if exists {
                fs::read_to_string(&p).unwrap_or_default()
            } else {
                String::new()
            };
            DocView {
                path: p.to_string_lossy().to_string(),
                exists,
                mtime: if exists { file_mtime_ms(&p) } else { 0 },
                content,
            }
        }
        None => DocView {
            path: String::new(),
            exists: false,
            content: String::new(),
            mtime: 0,
        },
    }
}

#[tauri::command]
fn list_memories(project: String) -> Result<Vec<MemoryNode>, String> {
    let root = projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    let memory_dir = root.join(&project).join("memory");
    let mut out = Vec::new();
    if !memory_dir.exists() {
        return Ok(out);
    }
    let entries = fs::read_dir(&memory_dir).map_err(|e| format!("读取 memory 目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let file = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if file == "MEMORY.md" {
            continue; // 索引文件不作为卡片
        }
        let mtime = file_mtime_ms(&path);
        match fs::read_to_string(&path) {
            Ok(content) => out.push(parse_memory(file, &content, mtime)),
            Err(e) => out.push(MemoryNode {
                file,
                name: None,
                description: None,
                mem_type: None,
                links: Vec::new(),
                body: String::new(),
                parse_error: Some(format!("读文件失败: {e}")),
                mtime,
                raw: String::new(),
            }),
        }
    }
    // 按类型再按文件名排序，归类清晰
    out.sort_by(|a, b| {
        a.mem_type
            .cmp(&b.mem_type)
            .then_with(|| a.file.cmp(&b.file))
    });
    Ok(out)
}

// ── 编辑回写 + 回收站 ─────────────────────────────────────────
//
// 设计：编辑直接覆盖（不留 .bak，保持目录干净），靠 expected_mtime 冲突检测
// + 前端保存前确认兜底；删除不物理删，移入 app 回收站可还原 / 一键清空。

/// 校验 memory 文件名安全：禁止路径穿越 / 分隔符，必须 .md。
fn safe_md_name(file: &str) -> Result<(), String> {
    if file.is_empty()
        || file.contains('/')
        || file.contains('\\')
        || file.contains("..")
        || !file.ends_with(".md")
    {
        return Err("非法文件名".into());
    }
    Ok(())
}

/// 校验项目目录名安全。
fn safe_project(project: &str) -> Result<(), String> {
    if project.is_empty()
        || project.contains('/')
        || project.contains('\\')
        || project.contains("..")
    {
        return Err("非法项目名".into());
    }
    Ok(())
}

fn memory_file_path(project: &str, file: &str) -> Result<PathBuf, String> {
    safe_project(project)?;
    safe_md_name(file)?;
    let root = projects_dir().ok_or("无法定位 projects 目录")?;
    Ok(root.join(project).join("memory").join(file))
}

/// 保存（覆盖）一条记忆。`expected_mtime > 0` 时与磁盘比对，不一致则拒绝
/// （防覆盖外部并发修改）。不留 .bak。返回新的 mtime 供前端更新。
#[tauri::command]
fn save_memory(
    project: String,
    file: String,
    content: String,
    expected_mtime: i64,
) -> Result<i64, String> {
    let path = memory_file_path(&project, &file)?;
    if !path.exists() {
        return Err("文件不存在".into());
    }
    if content.trim().is_empty() {
        return Err("内容为空，已拒绝保存".into());
    }
    if expected_mtime > 0 && file_mtime_ms(&path) != expected_mtime {
        return Err("文件已被外部修改（mtime 不一致），请刷新后再编辑".into());
    }
    fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(file_mtime_ms(&path))
}

/// 保存全局 CLAUDE.md（高危：影响所有项目）。同样做 mtime 冲突检测。
#[tauri::command]
fn save_global_md(content: String, expected_mtime: i64) -> Result<i64, String> {
    let path = global_md_path().ok_or("无法定位 CLAUDE.md")?;
    if content.trim().is_empty() {
        return Err("内容为空，已拒绝保存".into());
    }
    if path.exists() && expected_mtime > 0 && file_mtime_ms(&path) != expected_mtime {
        return Err("文件已被外部修改（mtime 不一致），请刷新后再编辑".into());
    }
    fs::write(&path, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(file_mtime_ms(&path))
}

// 回收站：~/.claude/.claudedeck-trash/，每个删除项一对文件
//   <id>.md   内容    /   <id>.json  元数据

fn trash_dir() -> Result<PathBuf, String> {
    Ok(claude_dir()?.join(".claudedeck-trash"))
}

#[derive(Debug, Serialize, Deserialize)]
struct TrashMeta {
    id: String,
    project: String,
    file: String,
    name: Option<String>,
    deleted_at: i64,
}

fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("非法 id".into());
    }
    Ok(())
}

/// 删除一条记忆 → 移入回收站（不物理删除）。
#[tauri::command]
fn delete_memory(project: String, file: String) -> Result<(), String> {
    let path = memory_file_path(&project, &file)?;
    if !path.exists() {
        return Err("文件不存在".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    let trash = trash_dir()?;
    fs::create_dir_all(&trash).map_err(|e| format!("创建回收站失败: {e}"))?;
    let now = now_ms();
    let id = format!("{}-{}", now, file.trim_end_matches(".md"));
    let name = parse_memory(file.clone(), &content, 0).name;
    let meta = TrashMeta {
        id: id.clone(),
        project,
        file,
        name,
        deleted_at: now,
    };
    fs::write(trash.join(format!("{id}.md")), &content)
        .map_err(|e| format!("写回收站失败: {e}"))?;
    let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(trash.join(format!("{id}.json")), meta_json)
        .map_err(|e| format!("写元数据失败: {e}"))?;
    fs::remove_file(&path).map_err(|e| format!("删除原文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn list_trash() -> Result<Vec<TrashMeta>, String> {
    let trash = trash_dir()?;
    let mut out = Vec::new();
    if !trash.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&trash)
        .map_err(|e| format!("读回收站失败: {e}"))?
        .flatten()
    {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(s) = fs::read_to_string(&p) {
            if let Ok(meta) = serde_json::from_str::<TrashMeta>(&s) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// 还原一条：移回原 project/memory/file。原位已存在同名则拒绝。
#[tauri::command]
fn restore_trash(id: String) -> Result<(), String> {
    safe_id(&id)?;
    let trash = trash_dir()?;
    let meta_path = trash.join(format!("{id}.json"));
    let md_path = trash.join(format!("{id}.md"));
    let meta: TrashMeta = serde_json::from_str(
        &fs::read_to_string(&meta_path).map_err(|e| format!("读元数据失败: {e}"))?,
    )
    .map_err(|e| format!("解析元数据失败: {e}"))?;
    let dest = memory_file_path(&meta.project, &meta.file)?;
    if dest.exists() {
        return Err("原位置已存在同名文件，无法还原".into());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let content = fs::read_to_string(&md_path).map_err(|e| format!("读回收站内容失败: {e}"))?;
    fs::write(&dest, content).map_err(|e| format!("还原写入失败: {e}"))?;
    let _ = fs::remove_file(&md_path);
    let _ = fs::remove_file(&meta_path);
    Ok(())
}

/// 彻底删除：`id` 为 None → 清空整个回收站；否则删单项。
#[tauri::command]
fn purge_trash(id: Option<String>) -> Result<(), String> {
    let trash = trash_dir()?;
    if !trash.exists() {
        return Ok(());
    }
    match id {
        Some(id) => {
            safe_id(&id)?;
            let _ = fs::remove_file(trash.join(format!("{id}.md")));
            let _ = fs::remove_file(trash.join(format!("{id}.json")));
        }
        None => {
            fs::remove_dir_all(&trash).map_err(|e| format!("清空失败: {e}"))?;
        }
    }
    Ok(())
}

// ── 项目 MEMORY.md 索引（读 / 写）+ 空目录物理删除 ──────────────

fn project_md_path(project: &str) -> Result<PathBuf, String> {
    safe_project(project)?;
    let root = projects_dir().ok_or("无法定位 projects 目录")?;
    Ok(root.join(project).join("memory").join("MEMORY.md"))
}

/// 读项目的 MEMORY.md 索引（项目记忆总览，文档型，非卡片）。
#[tauri::command]
fn read_project_md(project: String) -> Result<DocView, String> {
    let p = project_md_path(&project)?;
    let exists = p.exists();
    let content = if exists {
        fs::read_to_string(&p).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(DocView {
        path: p.to_string_lossy().to_string(),
        exists,
        mtime: if exists { file_mtime_ms(&p) } else { 0 },
        content,
    })
}

/// 保存项目 MEMORY.md（mtime 冲突检测）。
#[tauri::command]
fn save_project_md(project: String, content: String, expected_mtime: i64) -> Result<i64, String> {
    let p = project_md_path(&project)?;
    if content.trim().is_empty() {
        return Err("内容为空，已拒绝保存".into());
    }
    if p.exists() && expected_mtime > 0 && file_mtime_ms(&p) != expected_mtime {
        return Err("文件已被外部修改（mtime 不一致），请刷新后再编辑".into());
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    fs::write(&p, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(file_mtime_ms(&p))
}

/// 物理删除空的 memory 目录（连 MEMORY.md 一并删）。
/// 安全：仅当该目录无任何记忆卡片时才允许；只删 memory 子目录，
/// 绝不触碰 project 目录本身（其下还有会话 transcript）。
#[tauri::command]
fn delete_empty_memory_dir(project: String) -> Result<(), String> {
    safe_project(&project)?;
    let root = projects_dir().ok_or("无法定位 projects 目录")?;
    let mem = root.join(&project).join("memory");
    if !mem.exists() {
        return Ok(());
    }
    if count_memory_files(&mem) > 0 {
        return Err("该目录仍有记忆卡片，不能作为空目录删除".into());
    }
    fs::remove_dir_all(&mem).map_err(|e| format!("删除目录失败: {e}"))?;
    Ok(())
}

// ── Skill 可视化 ──────────────────────────────────────────────
//
// 数据源：`~/.claude/skills/<name>/SKILL.md`。标签存 app 独立文件
// `~/.claude/.claudedeck-skill-tags.json`（{ skill名: [标签...] }），不侵入 SKILL.md。

#[derive(Debug, Serialize)]
struct SkillInfo {
    /// 目录名，等同 skill id
    name: String,
    /// frontmatter 的 name 字段（展示标题；通常同目录名）
    title: Option<String>,
    description: Option<String>,
    dir: String,
    /// 目录顶层文件数（除 SKILL.md 外是否带脚本 / 资源的直观指标）
    file_count: usize,
    /// 是否含 references/ 子目录
    has_references: bool,
    mtime: i64,
    /// skill 目录创建时间（毫秒，用于「按添加日期」排序）
    created: i64,
    /// 用户打的标签（来自独立标签文件）
    tags: Vec<String>,
    /// 用户备注（来自独立备注文件，方便查找）
    note: Option<String>,
}

fn skills_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("skills"))
}

fn skill_tags_path() -> Result<PathBuf, String> {
    Ok(claude_dir()?.join(".claudedeck-skill-tags.json"))
}

fn read_all_skill_tags() -> HashMap<String, Vec<String>> {
    skill_tags_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn skill_notes_path() -> Result<PathBuf, String> {
    Ok(claude_dir()?.join(".claudedeck-skill-notes.json"))
}

fn read_all_skill_notes() -> HashMap<String, String> {
    skill_notes_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 解析 SKILL.md frontmatter 的 name / description（顶层平铺，单行）。
fn parse_skill_meta(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    if let Some(stripped) = content.strip_prefix("---") {
        if let Some(end) = stripped.find("\n---") {
            for line in stripped[..end].lines() {
                let t = line.trim();
                if let Some(v) = t.strip_prefix("name:") {
                    if name.is_none() {
                        name = Some(unquote(v));
                    }
                } else if let Some(v) = t.strip_prefix("description:") {
                    if desc.is_none() {
                        desc = Some(unquote(v));
                    }
                }
            }
        }
    }
    (name, desc)
}

/// 统计 skill 目录顶层文件数 + 是否有 references/ 子目录。
fn skill_file_stats(dir: &Path) -> (usize, bool) {
    let mut files = 0;
    let mut has_ref = false;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().and_then(|s| s.to_str()) == Some("references") {
                    has_ref = true;
                }
            } else {
                files += 1;
            }
        }
    }
    (files, has_ref)
}

/// 在 skill 目录里定位 SKILL.md（兼容小写 skill.md：项目 skill 常用小写，
/// Win 大小写不敏感本就能读到，Mac/Linux 大小写敏感故显式两个都试）。
fn find_skill_md(dir: &Path) -> Option<PathBuf> {
    for n in ["SKILL.md", "skill.md"] {
        let p = dir.join(n);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 解析 skills 根目录：project_dir=None → 个人 `~/.claude/skills`；
/// Some(项目目录) → `<项目>/.claude/skills`（校验项目目录存在）。
fn resolve_skills_root(project_dir: Option<&str>) -> Result<PathBuf, String> {
    match project_dir {
        None => skills_dir().ok_or_else(|| "无法定位 ~/.claude/skills 目录".to_string()),
        Some(pd) => {
            let p = PathBuf::from(pd);
            if !p.is_dir() {
                return Err("项目目录不存在".into());
            }
            Ok(p.join(".claude").join("skills"))
        }
    }
}

/// 扫描某个 skills 根目录下的所有 skill（个人 / 项目共用）。root 不存在返回空。
fn collect_skills(
    root: &Path,
    tags: &HashMap<String, Vec<String>>,
    notes: &HashMap<String, String>,
) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(root) else {
        return out; // 目录不存在 / 不可读 → 空列表（优雅降级）
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue; // 跳过散落的压缩包等非目录
        }
        let Some(skill_md) = find_skill_md(&path) else {
            continue; // 没有 SKILL.md 不算有效 skill
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let content = fs::read_to_string(&skill_md).unwrap_or_default();
        let (title, description) = parse_skill_meta(&content);
        let (file_count, has_references) = skill_file_stats(&path);
        let t = tags.get(&name).cloned().unwrap_or_default();
        let note = notes.get(&name).cloned().filter(|s| !s.is_empty());
        out.push(SkillInfo {
            name,
            title,
            description,
            dir: path.to_string_lossy().to_string(),
            file_count,
            has_references,
            mtime: file_mtime_ms(&skill_md),
            created: file_ctime_ms(&path),
            tags: t,
            note,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
fn list_skills() -> Result<Vec<SkillInfo>, String> {
    let dir = skills_dir().ok_or("无法定位 ~/.claude/skills 目录")?;
    let tags = read_all_skill_tags();
    let notes = read_all_skill_notes();
    Ok(collect_skills(&dir, &tags, &notes))
}

/// 列出某项目 `<项目>/.claude/skills` 下的专属 skill（只读：不带标签/备注，
/// 避免与个人 skill 按名共用标签库时串号）。
#[tauri::command]
fn list_project_skills(project_dir: String) -> Result<Vec<SkillInfo>, String> {
    let root = resolve_skills_root(Some(&project_dir))?;
    Ok(collect_skills(&root, &HashMap::new(), &HashMap::new()))
}

// ── 项目 skill 目录列表：%APPDATA%\ClaudeDeck\skill-projects.json ──────
// 用户手动添加「要查看专属 skill 的项目目录」，持久化一个绝对路径列表。

/// 返回给前端的项目条目（附展示名 + 是否真的有 .claude/skills）。
#[derive(Debug, Serialize)]
struct SkillProject {
    dir: String,
    label: String,
    has_skills: bool,
}

fn skill_projects_path() -> Option<PathBuf> {
    launcher_config_dir().map(|d| d.join("skill-projects.json"))
}

fn load_skill_projects() -> Vec<String> {
    skill_projects_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_skill_projects(list: &[String]) -> Result<(), String> {
    let dir = launcher_config_dir().ok_or("无法定位配置目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = skill_projects_path().ok_or("无法定位配置文件")?;
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写配置失败: {e}"))
}

fn skill_projects_view() -> Vec<SkillProject> {
    load_skill_projects()
        .into_iter()
        .map(|dir| {
            let p = PathBuf::from(&dir);
            let label = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| dir.clone());
            let has_skills = p.join(".claude").join("skills").is_dir();
            SkillProject {
                dir,
                label,
                has_skills,
            }
        })
        .collect()
}

#[tauri::command]
fn skill_projects_list() -> Vec<SkillProject> {
    skill_projects_view()
}

#[tauri::command]
fn skill_projects_add(dir: String) -> Result<Vec<SkillProject>, String> {
    let d = dir.trim().to_string();
    if d.is_empty() {
        return Err("目录为空".into());
    }
    if !PathBuf::from(&d).is_dir() {
        return Err("目录不存在".into());
    }
    let mut list = load_skill_projects();
    if !list.iter().any(|x| x == &d) {
        list.push(d);
    }
    save_skill_projects(&list)?;
    Ok(skill_projects_view())
}

#[tauri::command]
fn skill_projects_remove(dir: String) -> Result<Vec<SkillProject>, String> {
    let mut list = load_skill_projects();
    list.retain(|x| x != &dir);
    save_skill_projects(&list)?;
    Ok(skill_projects_view())
}

fn safe_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法 skill 名".into());
    }
    Ok(())
}

/// 读某个 skill 的 SKILL.md 全文。project_dir 给定则读该项目的专属 skill。
#[tauri::command]
fn read_skill(name: String, project_dir: Option<String>) -> Result<DocView, String> {
    safe_skill_name(&name)?;
    let root = resolve_skills_root(project_dir.as_deref())?;
    let sdir = root.join(&name);
    let p = find_skill_md(&sdir).unwrap_or_else(|| sdir.join("SKILL.md"));
    let exists = p.exists();
    let content = if exists {
        fs::read_to_string(&p).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(DocView {
        path: p.to_string_lossy().to_string(),
        exists,
        mtime: if exists { file_mtime_ms(&p) } else { 0 },
        content,
    })
}

/// skill 目录下的一个文件 / 子目录条目（相对 skill 根的路径）。
#[derive(Debug, Serialize)]
struct SkillFile {
    /// 相对 skill 根目录的路径，用 / 分隔（如 references/social.md）
    path: String,
    is_dir: bool,
    /// 文件字节数（目录为 0）
    size: u64,
}

fn collect_skill_tree(base: &Path, dir: &Path, out: &mut Vec<SkillFile>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    // 目录在前、再按名字排序，树形更清晰
    entries.sort_by(|a, b| {
        b.is_dir()
            .cmp(&a.is_dir())
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });
    for p in entries {
        let rel = p
            .strip_prefix(base)
            .ok()
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let is_dir = p.is_dir();
        let size = if is_dir {
            0
        } else {
            p.metadata().map(|m| m.len()).unwrap_or(0)
        };
        out.push(SkillFile {
            path: rel,
            is_dir,
            size,
        });
        if is_dir {
            collect_skill_tree(base, &p, out);
        }
    }
}

/// 列出某 skill 目录的完整文件结构（树形，供展示其组织，不读内容）。
/// project_dir 给定则列该项目专属 skill 的文件。
#[tauri::command]
fn list_skill_files(name: String, project_dir: Option<String>) -> Result<Vec<SkillFile>, String> {
    safe_skill_name(&name)?;
    let dir = resolve_skills_root(project_dir.as_deref())?.join(&name);
    if !dir.exists() {
        return Err("skill 不存在".into());
    }
    let mut out = Vec::new();
    collect_skill_tree(&dir, &dir, &mut out);
    Ok(out)
}

/// 在系统文件管理器中打开该 skill 目录（方便用户直接改文件）。
/// project_dir 给定则打开该项目专属 skill 的目录。
#[tauri::command]
fn open_skill_dir(name: String, project_dir: Option<String>) -> Result<(), String> {
    safe_skill_name(&name)?;
    let dir = resolve_skills_root(project_dir.as_deref())?.join(&name);
    if !dir.exists() {
        return Err("目录不存在".into());
    }
    #[cfg(windows)]
    let r = Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&dir).spawn();
    r.map_err(|e| format!("打开文件管理器失败: {e}"))?;
    Ok(())
}

/// 设置某 skill 的标签（空数组 = 清除该 skill 标签记录）。
#[tauri::command]
fn set_skill_tags(name: String, tags: Vec<String>) -> Result<(), String> {
    safe_skill_name(&name)?;
    let mut all = read_all_skill_tags();
    // 去空白、去重、去空串
    let mut cleaned: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_string();
        if !t.is_empty() && !cleaned.contains(&t) {
            cleaned.push(t);
        }
    }
    if cleaned.is_empty() {
        all.remove(&name);
    } else {
        all.insert(name, cleaned);
    }
    let p = skill_tags_path()?;
    let json = serde_json::to_string_pretty(&all).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&p, json).map_err(|e| format!("写标签文件失败: {e}"))?;
    Ok(())
}

/// 设置某 skill 的备注（空串 = 清除该 skill 备注记录）。
#[tauri::command]
fn set_skill_note(name: String, note: String) -> Result<(), String> {
    safe_skill_name(&name)?;
    let mut all = read_all_skill_notes();
    let note = note.trim().to_string();
    if note.is_empty() {
        all.remove(&name);
    } else {
        all.insert(name, note);
    }
    let p = skill_notes_path()?;
    let json = serde_json::to_string_pretty(&all).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&p, json).map_err(|e| format!("写备注文件失败: {e}"))?;
    Ok(())
}

// ── Skill 回收站：~/.claude/.claudedeck-trash/skills/ ──────────────
//   <id>/       被删 skill 目录整体（fs::rename 迁入，同卷快速）
//   <id>.json   元数据（含 tags / note 快照，供还原时恢复）

fn skill_trash_dir() -> Result<PathBuf, String> {
    Ok(trash_dir()?.join("skills"))
}

#[derive(Debug, Serialize, Deserialize)]
struct SkillTrashMeta {
    id: String,
    name: String,
    title: Option<String>,
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    note: Option<String>,
    deleted_at: i64,
}

/// 删除一个 skill → 整个目录移入回收站（不物理删除），连同标签/备注快照。
#[tauri::command]
fn delete_skill(name: String) -> Result<(), String> {
    safe_skill_name(&name)?;
    let src = skills_dir()
        .ok_or("无法定位 ~/.claude/skills 目录")?
        .join(&name);
    if !src.exists() {
        return Err("skill 不存在".into());
    }
    let trash = skill_trash_dir()?;
    fs::create_dir_all(&trash).map_err(|e| format!("创建回收站失败: {e}"))?;
    let now = now_ms();
    let id = format!("{now}-{name}");
    let dest = trash.join(&id);
    // 解析标题/描述用于回收站展示
    let content = fs::read_to_string(src.join("SKILL.md")).unwrap_or_default();
    let (title, description) = parse_skill_meta(&content);
    let tags = read_all_skill_tags().get(&name).cloned().unwrap_or_default();
    let note = read_all_skill_notes().get(&name).cloned();
    // 整目录迁入回收站（同卷 rename；跨卷失败则回退复制）
    if fs::rename(&src, &dest).is_err() {
        copy_dir_all(&src, &dest).map_err(|e| format!("移入回收站失败: {e}"))?;
        fs::remove_dir_all(&src).map_err(|e| format!("删除原目录失败: {e}"))?;
    }
    let meta = SkillTrashMeta {
        id: id.clone(),
        name: name.clone(),
        title,
        description,
        tags,
        note,
        deleted_at: now,
    };
    let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(trash.join(format!("{id}.json")), meta_json)
        .map_err(|e| format!("写元数据失败: {e}"))?;
    // 清掉 live 的标签/备注记录（快照已存 meta，还原时恢复）
    let _ = set_skill_tags(name.clone(), vec![]);
    let _ = set_skill_note(name, String::new());
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let p = entry.path();
        let target = dst.join(entry.file_name());
        if p.is_dir() {
            copy_dir_all(&p, &target)?;
        } else {
            fs::copy(&p, &target)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_skill_trash() -> Result<Vec<SkillTrashMeta>, String> {
    let trash = skill_trash_dir()?;
    let mut out = Vec::new();
    if !trash.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&trash)
        .map_err(|e| format!("读回收站失败: {e}"))?
        .flatten()
    {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(s) = fs::read_to_string(&p) {
            if let Ok(meta) = serde_json::from_str::<SkillTrashMeta>(&s) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

/// 还原一个 skill → 移回 ~/.claude/skills/<name>，并恢复标签/备注。
#[tauri::command]
fn restore_skill_trash(id: String) -> Result<(), String> {
    safe_id(&id)?;
    let trash = skill_trash_dir()?;
    let meta_path = trash.join(format!("{id}.json"));
    let dir_path = trash.join(&id);
    let meta: SkillTrashMeta = serde_json::from_str(
        &fs::read_to_string(&meta_path).map_err(|e| format!("读元数据失败: {e}"))?,
    )
    .map_err(|e| format!("解析元数据失败: {e}"))?;
    let dest = skills_dir()
        .ok_or("无法定位 ~/.claude/skills 目录")?
        .join(&meta.name);
    if dest.exists() {
        return Err("已存在同名 skill，无法还原".into());
    }
    if fs::rename(&dir_path, &dest).is_err() {
        copy_dir_all(&dir_path, &dest).map_err(|e| format!("还原失败: {e}"))?;
        let _ = fs::remove_dir_all(&dir_path);
    }
    let _ = fs::remove_file(&meta_path);
    if !meta.tags.is_empty() {
        let _ = set_skill_tags(meta.name.clone(), meta.tags);
    }
    if let Some(note) = meta.note {
        if !note.is_empty() {
            let _ = set_skill_note(meta.name, note);
        }
    }
    Ok(())
}

/// 彻底删除：`id` 为 None → 清空整个 skill 回收站；否则删单项。
#[tauri::command]
fn purge_skill_trash(id: Option<String>) -> Result<(), String> {
    let trash = skill_trash_dir()?;
    if !trash.exists() {
        return Ok(());
    }
    match id {
        Some(id) => {
            safe_id(&id)?;
            let _ = fs::remove_dir_all(trash.join(&id));
            let _ = fs::remove_file(trash.join(format!("{id}.json")));
        }
        None => {
            fs::remove_dir_all(&trash).map_err(|e| format!("清空失败: {e}"))?;
        }
    }
    Ok(())
}

// ── Claude 启动器（ClaudeDeck 自有配置，独立存储）─────────────────────
// 存 %APPDATA%\ClaudeDeck\launcher.json，与任何外部工具无耦合
// （开源用户不一定装其他启动器，故不共享配置）。

// 默认前置命令按 shell 给：Windows = PowerShell，macOS/Linux = bash export。
#[cfg(windows)]
const LAUNCHER_DEFAULT_PRE_CMD: &str = "$env:HTTP_PROXY = \"http://127.0.0.1:7897\"\r\n$env:HTTPS_PROXY = \"http://127.0.0.1:7897\"\r\n$env:ALL_PROXY = \"http://127.0.0.1:7897\"";
#[cfg(not(windows))]
const LAUNCHER_DEFAULT_PRE_CMD: &str = "export HTTP_PROXY=http://127.0.0.1:7897\nexport HTTPS_PROXY=http://127.0.0.1:7897\nexport ALL_PROXY=http://127.0.0.1:7897";

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecentDir {
    path: String,
    last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct LauncherConfig {
    recent_dirs: Vec<RecentDir>,
    pre_cmd_enabled: bool,
    pre_cmd: String,
    /// 用 Windows Terminal 在「当前窗口开新 tab」启动（多会话集中成 tab，免手动切窗口）。
    /// 默认开；WT 不可用时自动退回独立窗口。仅 Windows 生效。
    use_wt: bool,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            recent_dirs: vec![],
            pre_cmd_enabled: false,
            pre_cmd: LAUNCHER_DEFAULT_PRE_CMD.to_string(),
            use_wt: true,
        }
    }
}

fn launcher_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|c| c.join("ClaudeDeck"))
}

fn launcher_config_path() -> Option<PathBuf> {
    launcher_config_dir().map(|d| d.join("launcher.json"))
}

fn load_launcher_config() -> LauncherConfig {
    let Some(path) = launcher_config_path() else {
        return LauncherConfig::default();
    };
    if !path.exists() {
        return LauncherConfig::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return LauncherConfig::default(),
    };
    let mut cfg: LauncherConfig = serde_json::from_str(&text).unwrap_or_default();
    cfg.recent_dirs
        .sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    cfg
}

fn save_launcher_config(cfg: &LauncherConfig) -> Result<(), String> {
    let dir = launcher_config_dir().ok_or("无法定位启动器配置目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = launcher_config_path().ok_or("无法定位启动器配置文件")?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写配置失败: {e}"))
}

// ── UI 偏好（主题 / 通知设置 / 更新代理 / 视图状态…）─────────────────
// 这些偏好原本只写 webview 的 localStorage，而 Chromium 的 localStorage 是**延迟
// 批量**落盘的（秒级）；托盘「退出」走 `app.exit(0)`、更新重启、build 前 taskkill
// 都等价硬退出，刚改的值可能还没进 leveldb 就被丢弃 → 下次启动读回旧值（「主题
// 选了不记住」就是这么来的）。故真相改放后端：一张 key→字符串的扁平表，每次改动
// 同步写盘（与 launcher.json 同款）；前端的 localStorage 降级为首屏免闪烁的快取。
// value 一律字符串、与 localStorage 语义一一对应，结构化的值由前端自己
// JSON.stringify，后端不解释内容——这样以后新增偏好项零后端改动。
type UiPrefs = std::collections::BTreeMap<String, String>;

fn ui_prefs_path() -> Option<PathBuf> {
    launcher_config_dir().map(|d| d.join("ui-prefs.json"))
}

#[tauri::command]
fn get_ui_prefs() -> UiPrefs {
    let Some(path) = ui_prefs_path() else {
        return UiPrefs::new();
    };
    let mut prefs: UiPrefs = match fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => UiPrefs::new(),
    };
    // v0.12.7 只存主题、键名是 "theme"；v0.12.8 起统一沿用前端 localStorage 的键名。
    if let Some(theme) = prefs.remove("theme") {
        prefs.entry("cd-theme".into()).or_insert(theme);
    }
    prefs
}

#[tauri::command]
fn set_ui_pref(key: String, value: String) -> Result<(), String> {
    // 前端自己的偏好键，长度兜底即可（防手滑把整份会话之类塞进配置文件）。
    if key.is_empty() || key.len() > 64 || value.len() > 256 * 1024 {
        return Err("非法的偏好键值".into());
    }
    let mut prefs = get_ui_prefs();
    prefs.insert(key, value);
    let dir = launcher_config_dir().ok_or("无法定位配置目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = ui_prefs_path().ok_or("无法定位 UI 偏好文件")?;
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写配置失败: {e}"))
}

fn launcher_touch_and_sort(cfg: &mut LauncherConfig, path: &str) {
    let ts = now_secs();
    if let Some(entry) = cfg.recent_dirs.iter_mut().find(|r| r.path == path) {
        entry.last_opened_at = ts;
    } else {
        cfg.recent_dirs.push(RecentDir {
            path: path.to_string(),
            last_opened_at: ts,
        });
    }
    cfg.recent_dirs
        .sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
}

/// 标准 Base64 编码（PowerShell -EncodedCommand 用；手写避免引入依赖）。
#[cfg(windows)]
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 把一段 PowerShell 脚本编码成 `-EncodedCommand` 参数（UTF-16LE + Base64）。
/// 用 EncodedCommand 是为绕过 Windows Terminal 把 `;` 当命令分隔符的解析坑
/// （代理 pre_cmd 通常含 `;`）。
#[cfg(windows)]
fn ps_encoded(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64_encode(&utf16)
}

/// wt.exe（Windows Terminal）是否可用。静默 `where wt`，不弹窗。
#[cfg(windows)]
fn wt_available() -> bool {
    silent_command("where")
        .arg("wt")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// ClaudeDeck 专属的 Windows Terminal 具名窗口。所有从启动器开的会话都集中进这个
/// 窗口（`-w <name>`：不存在则新建、已存在则在其中开新 tab），与用户其他 WT 窗口隔离。
/// 用具名窗口而非 `-w 0`(最近使用的窗口) 是为避免「多个 WT 窗口时甩进哪个不可控」。
#[cfg(windows)]
const WT_WINDOW_NAME: &str = "ClaudeDeck";

/// 构造启动命令：无 resume_id → `claude`（新会话）；有则 `claude --resume <id>`（续指定会话）。
/// session_id 是 UUID（`[0-9a-fA-F-]`），调用方已校验，这里直接拼接安全。
fn claude_cmd(resume_id: Option<&str>) -> String {
    match resume_id {
        Some(id) if !id.trim().is_empty() => format!("claude --resume {}", id.trim()),
        _ => "claude".to_string(),
    }
}

#[cfg(windows)]
fn spawn_claude(
    dir: &str,
    pre_cmd_enabled: bool,
    pre_cmd: &str,
    use_wt: bool,
    resume_id: Option<&str>,
) -> Result<(), String> {
    let cc = claude_cmd(resume_id);
    // 脚本：可选 pre_cmd（如注入代理）后起 claude / claude --resume。
    let script = if pre_cmd_enabled && !pre_cmd.trim().is_empty() {
        format!("{}\n{}", pre_cmd.trim(), cc)
    } else {
        cc.clone()
    };

    // WT 多 tab 工作区模式：在「ClaudeDeck 专属具名窗口」(`-w ClaudeDeck`) 甩一个新 tab，
    // 自动切到项目目录(`-d`) + 注入代理 + 起 claude。所有会话集中进这一个窗口、和用户
    // 其他 WT 窗口隔离，免手动在终端窗口间切换。
    if use_wt && wt_available() {
        let title = Path::new(dir)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("claude");
        let b64 = ps_encoded(&script);
        // wt 是 GUI，CREATE_NO_WINDOW 防任何控制台黑窗；tab 在 WT 窗口里正常显示。
        let ok = silent_command("wt")
            .args([
                "-w",
                WT_WINDOW_NAME,
                "new-tab",
                "-d",
                dir,
                "--title",
                title,
                "powershell",
                "-NoProfile",
                "-NoExit",
                "-EncodedCommand",
                &b64,
            ])
            .spawn()
            .is_ok();
        if ok {
            return Ok(());
        }
        // wt 调用失败 → 落到下面独立窗口兜底。
    }

    // 独立窗口模式（WT 不可用 / 用户关闭 / 调用失败兜底）。要弹终端窗口，不加 CREATE_NO_WINDOW。
    let r = if pre_cmd_enabled && !pre_cmd.trim().is_empty() {
        Command::new("powershell")
            .args(["-NoExit", "-Command", &script])
            .current_dir(dir)
            .spawn()
    } else {
        Command::new("cmd")
            .args(["/k", &cc])
            .current_dir(dir)
            .spawn()
    };
    r.map(|_| ()).map_err(|e| format!("启动 Claude 失败: {e}"))
}

/// POSIX shell 单引号安全包裹（把 dir / 命令安全嵌进 shell 字符串）。
#[cfg(not(windows))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn spawn_claude(
    dir: &str,
    pre_cmd_enabled: bool,
    pre_cmd: &str,
    _use_wt: bool,
    resume_id: Option<&str>,
) -> Result<(), String> {
    // use_wt 是 Windows Terminal 专属，macOS 忽略。
    // 用 Terminal.app 开新窗口：cd 到目录后（可选前置命令）跑 claude / claude --resume。
    // 关键：pre_cmd 默认是多行（代理 export 各占一行），但 AppleScript 字符串字面量
    // **不能含裸换行**，否则 `do script "..."` 直接语法报错、启动器静默失败。
    // 故把换行压成 `; `（这些前置命令本就是顺序执行的独立语句）。
    let cc = claude_cmd(resume_id);
    let pre = pre_cmd.trim().replace('\r', "").replace('\n', " ; ");
    let inner = if pre_cmd_enabled && !pre.is_empty() {
        format!("cd {} && {} ; {}", sh_quote(dir), pre, cc)
    } else {
        format!("cd {} && {}", sh_quote(dir), cc)
    };
    // 嵌进 AppleScript 字符串：转义反斜杠与双引号。
    let escaped = inner.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(r#"tell application "Terminal" to do script "{escaped}""#);
    Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map_err(|e| format!("启动 Claude 失败: {e}"))?;
    // 把 Terminal 带到前台。
    let _ = Command::new("osascript")
        .args(["-e", r#"tell application "Terminal" to activate"#])
        .spawn();
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_claude(
    dir: &str,
    pre_cmd_enabled: bool,
    pre_cmd: &str,
    _use_wt: bool,
    resume_id: Option<&str>,
) -> Result<(), String> {
    // use_wt 是 Windows Terminal 专属，Linux 忽略。
    // 尽力用常见终端模拟器开窗跑 claude / claude --resume，失败再退回无窗口直接 spawn。
    let cc = claude_cmd(resume_id);
    let inner = if pre_cmd_enabled && !pre_cmd.trim().is_empty() {
        format!("cd {} && {} ; {}; exec bash", sh_quote(dir), pre_cmd.trim(), cc)
    } else {
        format!("cd {} && {}; exec bash", sh_quote(dir), cc)
    };
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if Command::new(term)
            .args(["-e", "bash", "-c", &inner])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    let mut fallback = Command::new("claude");
    if let Some(id) = resume_id {
        if !id.trim().is_empty() {
            fallback.args(["--resume", id.trim()]);
        }
    }
    fallback
        .current_dir(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("启动 Claude 失败: {e}"))
}

#[tauri::command]
fn launcher_get_config() -> LauncherConfig {
    load_launcher_config()
}

#[tauri::command]
fn launcher_add_dir(path: String) -> Result<LauncherConfig, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("路径为空".into());
    }
    let mut cfg = load_launcher_config();
    launcher_touch_and_sort(&mut cfg, p);
    save_launcher_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn launcher_remove_dir(path: String) -> Result<LauncherConfig, String> {
    let mut cfg = load_launcher_config();
    cfg.recent_dirs.retain(|r| r.path != path);
    save_launcher_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn launcher_save_precmd(enabled: bool, pre_cmd: String) -> Result<(), String> {
    let mut cfg = load_launcher_config();
    cfg.pre_cmd_enabled = enabled;
    cfg.pre_cmd = pre_cmd;
    save_launcher_config(&cfg)
}

/// 切换「用 Windows Terminal 开新 tab」模式（多会话集中成 tab，免手动切窗口）。
#[tauri::command]
fn launcher_set_use_wt(enabled: bool) -> Result<(), String> {
    let mut cfg = load_launcher_config();
    cfg.use_wt = enabled;
    save_launcher_config(&cfg)
}

#[tauri::command]
fn launcher_launch(path: String) -> Result<LauncherConfig, String> {
    let p = path.trim().to_string();
    if p.is_empty() {
        return Err("路径为空".into());
    }
    if !Path::new(&p).exists() {
        return Err(format!("目录不存在：{p}"));
    }
    let mut cfg = load_launcher_config();
    launcher_touch_and_sort(&mut cfg, &p);
    save_launcher_config(&cfg)?;
    spawn_claude(&p, cfg.pre_cmd_enabled, &cfg.pre_cmd, cfg.use_wt, None)?;
    Ok(cfg)
}

/// 在原项目目录下「续上」一个已存在的会话（`claude --resume <session_id>`）。
/// 复用启动器配置的代理/前置命令与 WT 设置；但**不**写入「最近项目」列表
/// （续旧会话不等于把该目录当新工作目录，避免污染启动器近期列表）。
/// session_id 仅允许 UUID 字符集（`[0-9a-zA-Z-]`），挡命令注入。
#[tauri::command]
fn launcher_resume(path: String, session_id: String) -> Result<(), String> {
    let p = path.trim().to_string();
    if p.is_empty() {
        return Err("路径为空".into());
    }
    if !Path::new(&p).exists() {
        return Err(format!("目录不存在：{p}"));
    }
    let sid = session_id.trim();
    if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("非法的会话 ID".into());
    }
    let cfg = load_launcher_config();
    spawn_claude(&p, cfg.pre_cmd_enabled, &cfg.pre_cmd, cfg.use_wt, Some(sid))
}

// ── 会话收藏夹（favorites）────────────────────────────────────────────
// 用户把「还没聊完、关机后想回来续」的会话加进收藏夹，下次一键 resume。
// 存 launcher.json 同目录的 favorites.json（一个 Favorite 数组）。
// 只存续会话所需的快照字段（session_id/cwd/title…）；running / missing 在 list 时
// 实时计算（交叉运行中 pid + 文件是否还在），不持久化。

/// 持久化的一条收藏（快照，跟着会话走）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Favorite {
    session_id: String,
    /// jsonl 绝对路径（续会话不直接用，但用于判定文件是否还在 + 删除联动）
    file: String,
    cwd: Option<String>,
    project: Option<String>,
    title: Option<String>,
    /// 收藏时间（unix 秒）
    added_at: u64,
}

/// 返回给前端的收藏（带实时计算的 running / missing / 文件大小 / 最后活跃时间）。
#[derive(Debug, Serialize)]
struct FavoriteView {
    #[serde(flatten)]
    fav: Favorite,
    /// 该会话当前是否有活进程（运行中不可续——避免对同一 jsonl 开第二个 REPL）
    running: bool,
    /// jsonl 是否已不存在（会话被删/移走，收藏成了悬空项）
    missing: bool,
    /// jsonl 文件大小（字节，missing 时 0），与最近会话一致展示
    size_bytes: u64,
    /// 最后活跃时间 = jsonl 文件 mtime（unix 毫秒，missing/不可读时 0）
    last_active_ms: i64,
}

fn favorites_path() -> Option<PathBuf> {
    launcher_config_dir().map(|d| d.join("favorites.json"))
}

fn load_favorites() -> Vec<Favorite> {
    let Some(path) = favorites_path() else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_favorites(list: &[Favorite]) -> Result<(), String> {
    let dir = launcher_config_dir().ok_or("无法定位配置目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = favorites_path().ok_or("无法定位收藏文件")?;
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写收藏失败: {e}"))
}

/// 列出收藏（按收藏时间倒序），实时附上 running / missing。
#[tauri::command]
fn favorites_list() -> Vec<FavoriteView> {
    let running: HashSet<String> = read_session_views()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.alive)
        .filter_map(|s| s.session_id)
        .collect();
    let mut list = load_favorites();
    list.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    list.into_iter()
        .map(|f| {
            // 一次 stat 同时拿到：是否存在（missing）、文件大小、最后活跃时间（mtime）
            let meta = fs::metadata(&f.file).ok();
            let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let last_active_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            FavoriteView {
                running: running.contains(&f.session_id),
                missing: meta.is_none(),
                size_bytes,
                last_active_ms,
                fav: f,
            }
        })
        .collect()
}

/// 加入收藏（按 session_id 去重；已存在则更新快照）。
#[tauri::command]
fn favorites_add(
    session_id: String,
    file: String,
    cwd: Option<String>,
    project: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() {
        return Err("会话 ID 为空".into());
    }
    let mut list = load_favorites();
    let entry = Favorite {
        session_id: sid.clone(),
        file,
        cwd,
        project,
        title,
        added_at: now_secs(),
    };
    if let Some(slot) = list.iter_mut().find(|f| f.session_id == sid) {
        let added_at = slot.added_at; // 保留原收藏时间
        *slot = Favorite { added_at, ..entry };
    } else {
        list.push(entry);
    }
    save_favorites(&list)
}

/// 取消收藏。
#[tauri::command]
fn favorites_remove(session_id: String) -> Result<(), String> {
    let sid = session_id.trim();
    let mut list = load_favorites();
    list.retain(|f| f.session_id != sid);
    save_favorites(&list)
}

// ── 定时开窗（warmup）────────────────────────────────────────────────
// Claude 的 5 小时使用窗口从「发出第一条消息」起算（rolling，不对齐自然日）——
// 仅启动 claude REPL 不发消息**不会**开窗。所以这里到点跑 `claude -p "<prompt>"`
// （headless：非交互发一条极简消息→拿回复即退出，token 极小），真正开启 5h 窗口。
// 调度引擎在 app 内（后台线程 + 系统托盘常驻 + 可选开机自启），配置全在 app 内可视化、
// 跨平台一致、卸载零残留。复用启动器的代理 pre_cmd（开窗要发网络请求）。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct WarmupTrigger {
    id: String,
    /// 触发时刻 "HH:MM"（24 小时制，本地时区）
    time: String,
    /// 生效星期：0=周一 .. 6=周日；空 = 每天
    days: Vec<u8>,
    enabled: bool,
}
impl Default for WarmupTrigger {
    fn default() -> Self {
        Self {
            id: String::new(),
            time: "07:00".into(),
            days: vec![],
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ScheduleConfig {
    /// 总开关：关闭则所有触发点都不生效
    enabled: bool,
    triggers: Vec<WarmupTrigger>,
    /// 开窗时发给 claude 的极简 prompt
    warmup_prompt: String,
    /// 上次开窗时间（unix ms，0=从未）
    last_run_ms: i64,
    last_run_ok: bool,
    last_run_msg: String,
}
impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            triggers: vec![],
            warmup_prompt: "ok".into(),
            last_run_ms: 0,
            last_run_ok: false,
            last_run_msg: String::new(),
        }
    }
}

fn schedule_config_path() -> Option<PathBuf> {
    launcher_config_dir().map(|d| d.join("schedule.json"))
}

fn load_schedule_config() -> ScheduleConfig {
    let Some(path) = schedule_config_path() else {
        return ScheduleConfig::default();
    };
    if !path.exists() {
        return ScheduleConfig::default();
    }
    match fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => ScheduleConfig::default(),
    }
}

fn save_schedule_config(cfg: &ScheduleConfig) -> Result<(), String> {
    let dir = launcher_config_dir().ok_or("无法定位配置目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = schedule_config_path().ok_or("无法定位定时配置文件")?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写配置失败: {e}"))
}

/// 校验 "HH:MM"（两位时、两位分，24 小时制）。
fn valid_hhmm(s: &str) -> bool {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 || parts[0].len() != 2 || parts[1].len() != 2 {
        return false;
    }
    match (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
        (Ok(h), Ok(m)) => h < 24 && m < 60,
        _ => false,
    }
}

/// PowerShell 单引号字面量转义（内部单引号翻倍）。
#[cfg(windows)]
fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 同步跑一次开窗（`claude -p <prompt>`），带 120s 超时，返回 (成功?, 简述)。
/// 复用启动器的代理 pre_cmd——开窗要发网络请求，挂代理后用户才连得上。
fn run_warmup(prompt: &str, pre_cmd_enabled: bool, pre_cmd: &str) -> (bool, String) {
    let p = if prompt.trim().is_empty() {
        "ok"
    } else {
        prompt.trim()
    };

    // 为本次预热开窗指定一个专属会话 ID（合法 UUID），成功后按此 ID 精确删掉
    // 产生的「ok→OK」垃圾会话 jsonl，避免污染会话列表（曹少 2026-07-03）。
    // uuid 仅含 [0-9a-f-]，直接拼进命令无注入风险。
    let session_id = uuid::Uuid::new_v4().to_string();

    #[cfg(windows)]
    let mut cmd = {
        let script = if pre_cmd_enabled && !pre_cmd.trim().is_empty() {
            format!(
                "{}\nclaude -p --session-id {} {}",
                pre_cmd.trim(),
                session_id,
                ps_single_quote(p)
            )
        } else {
            format!("claude -p --session-id {} {}", session_id, ps_single_quote(p))
        };
        let b64 = ps_encoded(&script);
        let mut c = silent_command("powershell");
        c.args(["-NoProfile", "-EncodedCommand", &b64]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let inner = if pre_cmd_enabled && !pre_cmd.trim().is_empty() {
            format!(
                "{} ; claude -p --session-id {} {}",
                pre_cmd.trim(),
                session_id,
                sh_quote(p)
            )
        } else {
            format!("claude -p --session-id {} {}", session_id, sh_quote(p))
        };
        // 登录 shell 以拿到含 claude 的 PATH。
        let mut c = silent_command("sh");
        c.args(["-lc", &inner]);
        c
    };

    // 在用户主目录跑（稳定、通常已被 claude 信任，避开新目录的 folder-trust 询问）。
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }

    // 在独立线程跑（output() 会读尽管道、且自动关 stdin，claude -p 不会卡等输入），
    // 用 channel 套 120s 超时，避免极端情况下挂死调度线程。
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(Ok(o)) => {
            if o.status.success() {
                let cleaned = delete_warmup_session(&session_id);
                let tail = if cleaned { "，已自动清理预热会话" } else { "" };
                (
                    true,
                    format!("开窗成功：已发送一条消息，5 小时窗口开始计时{tail}"),
                )
            } else {
                let err = String::from_utf8_lossy(&o.stderr);
                let snippet: String = err.trim().chars().take(300).collect();
                (
                    false,
                    format!(
                        "claude 返回非 0：{}",
                        if snippet.is_empty() {
                            "(无错误输出，确认已登录 claude 且代理可用)".into()
                        } else {
                            snippet
                        }
                    ),
                )
            }
        }
        Ok(Err(e)) => (false, format!("无法启动 claude：{e}")),
        Err(_) => (false, "开窗超时（120 秒未返回）".to_string()),
    }
}

/// 删除某次预热开窗产生的会话 jsonl（best-effort，删不掉不影响开窗结果）。
/// 预热在 home 目录跑，会话必落在 `~/.claude/projects/<home 编码>/<session_id>.jsonl`；
/// 为跨平台稳健，直接在所有 project 子目录里找唯一的 `<session_id>.jsonl` 删除。
fn delete_warmup_session(session_id: &str) -> bool {
    let Some(root) = projects_dir() else {
        return false;
    };
    let target = format!("{session_id}.jsonl");
    let Ok(entries) = fs::read_dir(&root) else {
        return false;
    };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(&target);
        if candidate.is_file() {
            return fs::remove_file(&candidate).is_ok();
        }
    }
    false
}

fn record_warmup_result(ok: bool, msg: &str) {
    let mut cfg = load_schedule_config();
    cfg.last_run_ms = now_ms();
    cfg.last_run_ok = ok;
    cfg.last_run_msg = msg.to_string();
    let _ = save_schedule_config(&cfg);
}

/// 后台调度线程：每 30s 醒一次，比对本地时间与各启用触发点，命中即开窗。
/// 按「分钟键」去重，确保同一时刻只触发一次。
fn scheduler_loop(app: tauri::AppHandle) {
    use chrono::{Datelike, Local};
    let mut last_fired: HashMap<String, String> = HashMap::new();
    loop {
        std::thread::sleep(Duration::from_secs(30));
        let cfg = load_schedule_config();
        if !cfg.enabled {
            continue;
        }
        let now = Local::now();
        let hm = now.format("%H:%M").to_string();
        let minute_key = now.format("%Y-%m-%d %H:%M").to_string();
        let weekday = now.weekday().num_days_from_monday() as u8; // 0=周一
        for t in &cfg.triggers {
            if !t.enabled || t.time != hm {
                continue;
            }
            if !t.days.is_empty() && !t.days.contains(&weekday) {
                continue;
            }
            if last_fired.get(&t.id).map(|s| s.as_str()) == Some(minute_key.as_str()) {
                continue;
            }
            last_fired.insert(t.id.clone(), minute_key.clone());

            let lc = load_launcher_config();
            let (ok, msg) = run_warmup(&cfg.warmup_prompt, lc.pre_cmd_enabled, &lc.pre_cmd);
            record_warmup_result(ok, &msg);
            let title = if ok {
                "⏰ Claude 5 小时窗口已开启"
            } else {
                "⚠️ 定时开窗失败"
            };
            let _ = app
                .notification()
                .builder()
                .title(title)
                .body(msg.as_str())
                .show();
        }
    }
}

/// 把会话导出的 Markdown 文本写到用户经保存对话框选定的路径（会话 A 读会话 B 用）。
/// 路径由前端 dialog::save 产生（用户主动选定），此处仅做父目录存在性校验。
#[tauri::command]
fn export_session_md(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() && !dir.is_dir() {
            return Err(format!("目标目录不存在：{}", dir.display()));
        }
    }
    fs::write(p, content).map_err(|e| format!("导出写入失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn schedule_get_config() -> ScheduleConfig {
    load_schedule_config()
}

#[tauri::command]
fn schedule_set_enabled(enabled: bool) -> Result<ScheduleConfig, String> {
    let mut cfg = load_schedule_config();
    cfg.enabled = enabled;
    save_schedule_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn schedule_set_prompt(prompt: String) -> Result<ScheduleConfig, String> {
    let mut cfg = load_schedule_config();
    cfg.warmup_prompt = prompt;
    save_schedule_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn schedule_add_trigger(time: String, days: Vec<u8>) -> Result<ScheduleConfig, String> {
    let t = time.trim().to_string();
    if !valid_hhmm(&t) {
        return Err("时间格式应为 HH:MM（如 07:00）".into());
    }
    let mut days = days;
    days.retain(|d| *d <= 6);
    days.sort_unstable();
    days.dedup();
    let mut cfg = load_schedule_config();
    if cfg.triggers.iter().any(|x| x.time == t && x.days == days) {
        return Err("已存在相同时间与星期的触发点".into());
    }
    // 添加「第一个」触发点时自动打开总开关——否则用户加了触发点却忘了开总开关，
    // 定时永远不触发（曹少 2026-06-15 踩过：总开关默认关，4 个触发点全不生效）。
    let was_empty = cfg.triggers.is_empty();
    let id = format!("{}-{}", t.replace(':', ""), now_ms());
    cfg.triggers.push(WarmupTrigger {
        id,
        time: t,
        days,
        enabled: true,
    });
    cfg.triggers.sort_by(|a, b| a.time.cmp(&b.time));
    if was_empty {
        cfg.enabled = true;
    }
    save_schedule_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn schedule_remove_trigger(id: String) -> Result<ScheduleConfig, String> {
    let mut cfg = load_schedule_config();
    cfg.triggers.retain(|x| x.id != id);
    save_schedule_config(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn schedule_toggle_trigger(id: String, enabled: bool) -> Result<ScheduleConfig, String> {
    let mut cfg = load_schedule_config();
    if let Some(t) = cfg.triggers.iter_mut().find(|x| x.id == id) {
        t.enabled = enabled;
    }
    save_schedule_config(&cfg)?;
    Ok(cfg)
}

/// 立即手动开窗一次（测试用），同步返回最新配置（含 last_run_*）。失败抛错。
#[tauri::command]
fn schedule_run_now() -> Result<ScheduleConfig, String> {
    let cfg = load_schedule_config();
    let lc = load_launcher_config();
    let (ok, msg) = run_warmup(&cfg.warmup_prompt, lc.pre_cmd_enabled, &lc.pre_cmd);
    record_warmup_result(ok, &msg);
    if !ok {
        return Err(msg);
    }
    Ok(load_schedule_config())
}

#[tauri::command]
fn schedule_get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn schedule_set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let m = app.autolaunch();
    let r = if enabled { m.enable() } else { m.disable() };
    r.map_err(|e| format!("设置开机自启失败：{e}"))?;
    Ok(m.is_enabled().unwrap_or(enabled))
}

/// 前端下发「关窗是否隐藏到托盘」（true=隐藏常驻，false=关窗即退出）。
#[tauri::command]
fn set_close_to_tray(enabled: bool, state: tauri::State<Arc<AtomicBool>>) {
    state.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn set_notify_config(cfg: NotifyConfig, state: tauri::State<Arc<Mutex<NotifyConfig>>>) {
    if let Ok(mut g) = state.lock() {
        *g = cfg;
    }
}

// ── 手机推送（Bark）hook 一键安装 ──────────────────────────────
//
// 把任务完成 / 等待授权通过 CC 原生 hook 推到手机。脚本与 settings.json 都在
// `~/.claude/` 下，**应用不用常驻**，靠 CC 进程自己触发。

/// 标记字符串：用于在 settings.json 里识别「我们装的」hook，做幂等增删。
const HOOK_MARKER: &str = "claudedeck-bark-notify";

/// hook 脚本模板（Windows = PowerShell .ps1，macOS/Linux = bash .sh）。
/// `__BARK_KEY__` / `__PUSHPLUS_TOKEN__` / `__*_ENABLED__` / `__THRESHOLD_MS__` 安装时替换。
/// 写盘时前置 UTF-8 BOM，否则 Windows PowerShell 5.1 按 GBK 读中文会乱码。
/// 两渠道可同时启用：bark(iPhone 免费) + pushplus(微信，需实名)，各自有 key 就推。
/// 中文编码坑：PowerShell 调 curl.exe 直传中文参数会乱码 →
/// 用 [uri]::EscapeDataString 在 PS 里先 URL 编码、只把 ASCII 传给 curl。
#[cfg(windows)]
const PHONE_HOOK_SCRIPT: &str = r##"# ClaudeDeck — Claude Code hook → 手机推送(bark / pushplus)
# 本文件由 ClaudeDeck 自动生成与管理，请勿手改（在应用里改渠道 / key / 阈值即可）。
$ErrorActionPreference = 'SilentlyContinue'
# 强制 UTF-8 读 stdin：CC 写 UTF-8，5.1 的 [Console]::In 默认 GBK 会解析失败。
$raw = ''
try {
    $sr = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
    $raw = $sr.ReadToEnd()
    $sr.Dispose()
} catch { }
$j = $null
if ($raw) { try { $j = $raw | ConvertFrom-Json } catch { } }
$cwd = if ($j -and $j.cwd) { [string]$j.cwd } else { '' }
$proj = if ($cwd) { Split-Path $cwd -Leaf } else { '会话' }
$ev = if ($j) { [string]$j.hook_event_name } else { '' }
$sid = if ($j -and $j.session_id) { [string]$j.session_id } else { 'unknown' }
$stateDir = Join-Path $env:USERPROFILE '.claude\hooks\.state'
$stateFile = Join-Path $stateDir $sid
$barkKey = '__BARK_KEY__'
$barkEnabled = __BARK_ENABLED__
$pushplusToken = '__PUSHPLUS_TOKEN__'
$pushplusEnabled = __PUSHPLUS_ENABLED__
$THRESHOLD_MS = __THRESHOLD_MS__
if ($ev -eq 'UserPromptSubmit') {
    try {
        if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force $stateDir > $null }
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() | Set-Content -Path $stateFile -Encoding ASCII
    } catch { }
    exit 0
}
if ($ev -eq 'Stop') {
    $start = $null
    if (Test-Path $stateFile) {
        try { $start = [int64]((Get-Content $stateFile -Raw).Trim()) } catch { }
        Remove-Item $stateFile -Force
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $dur = if ($start) { $now - $start } else { 0 }
    if ($dur -lt $THRESHOLD_MS) { exit 0 }
    $sec = [int]($dur / 1000)
    $durTxt = if ($sec -lt 60) { "${sec}s" } else { "{0}m{1}s" -f [int]($sec / 60), ($sec % 60) }
    $title = "✅ $proj · 任务完成"
    $body = "用时 $durTxt"
    $sound = 'birdsong'
}
elseif ($ev -eq 'Notification') {
    $msg = if ($j -and $j.message) { [string]$j.message } else { '' }
    $title = "⏳ $proj · 需要你处理"
    $body = if ($msg) { $msg } elseif ($cwd) { $cwd } else { '等待你的操作' }
    $sound = 'alarm'
}
else { exit 0 }
function Enc([string]$s) { [uri]::EscapeDataString($s) }
# 两个渠道独立：key 非空且该渠道已启用才推，可同时推也可只推其一
if ($barkKey -and $barkEnabled) {
    $data = "title=$(Enc $title)&body=$(Enc $body)&group=ClaudeDeck&sound=$sound"
    & curl.exe -s -X POST "https://api.day.app/$barkKey" --data $data > $null
}
if ($pushplusToken -and $pushplusEnabled) {
    $data = "token=$pushplusToken&title=$(Enc $title)&content=$(Enc $body)"
    & curl.exe -s -X POST "https://www.pushplus.plus/send" --data $data > $null
}
exit 0
"##;

/// macOS / Linux 版 hook 脚本（bash）。仅用系统自带 curl + perl（macOS 预装）。
/// JSON 字段提取与 URL 编码都走 perl，避免依赖 jq。变量行格式固定，供状态回填解析。
#[cfg(not(windows))]
const PHONE_HOOK_SCRIPT: &str = r###"#!/bin/bash
# ClaudeDeck — Claude Code hook → 手机推送(bark / pushplus)
# 本文件由 ClaudeDeck 自动生成与管理，请勿手改（在应用里改渠道 / key / 阈值即可）。
raw=$(cat)
get() { FIELD="$1" perl -0777 -ne 'print $1 if /"$ENV{FIELD}"\s*:\s*"((?:[^"\\]|\\.)*)"/' <<<"$raw"; }
cwd=$(get cwd)
ev=$(get hook_event_name)
sid=$(get session_id)
[ -z "$sid" ] && sid=unknown
if [ -n "$cwd" ]; then proj=$(basename "$cwd"); else proj="会话"; fi
stateDir="$HOME/.claude/hooks/.state"
stateFile="$stateDir/$sid"
barkKey='__BARK_KEY__'
barkEnabled=__BARK_ENABLED__
pushplusToken='__PUSHPLUS_TOKEN__'
pushplusEnabled=__PUSHPLUS_ENABLED__
THRESHOLD_MS=__THRESHOLD_MS__
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time()*1000'; }
if [ "$ev" = "UserPromptSubmit" ]; then
    mkdir -p "$stateDir"
    now_ms > "$stateFile"
    exit 0
fi
if [ "$ev" = "Stop" ]; then
    start=""
    if [ -f "$stateFile" ]; then start=$(cat "$stateFile" 2>/dev/null); rm -f "$stateFile"; fi
    now=$(now_ms)
    if [ -n "$start" ]; then dur=$((now - start)); else dur=0; fi
    if [ "$dur" -lt "$THRESHOLD_MS" ]; then exit 0; fi
    sec=$((dur / 1000))
    if [ "$sec" -lt 60 ]; then durTxt="${sec}s"; else durTxt="$((sec / 60))m$((sec % 60))s"; fi
    title="✅ $proj · 任务完成"
    body="用时 $durTxt"
    sound="birdsong"
elif [ "$ev" = "Notification" ]; then
    msg=$(get message)
    title="⏳ $proj · 需要你处理"
    if [ -n "$msg" ]; then body="$msg"; elif [ -n "$cwd" ]; then body="$cwd"; else body="等待你的操作"; fi
    sound="alarm"
else
    exit 0
fi
enc() { perl -e 'my $s=$ARGV[0]; $s=~s/([^A-Za-z0-9_.~-])/sprintf("%%%02X",ord($1))/ge; print $s;' "$1"; }
if [ -n "$barkKey" ] && [ "$barkEnabled" = "true" ]; then
    data="title=$(enc "$title")&body=$(enc "$body")&group=ClaudeDeck&sound=$sound"
    curl -s -X POST "https://api.day.app/$barkKey" --data "$data" >/dev/null
fi
if [ -n "$pushplusToken" ] && [ "$pushplusEnabled" = "true" ]; then
    data="token=$pushplusToken&title=$(enc "$title")&content=$(enc "$body")"
    curl -s -X POST "https://www.pushplus.plus/send" --data "$data" >/dev/null
fi
exit 0
"###;

/// 手机 hook 当前状态，回传前端用于回填表单 + 显示开关。
#[derive(Debug, Serialize)]
struct PhoneHookStatus {
    installed: bool,
    script_exists: bool,
    /// Bark key（iPhone），为空表示未配置该渠道
    bark_key: Option<String>,
    /// Bark 渠道是否启用（key 已填时才有意义）
    bark_enabled: bool,
    /// PushPlus token（微信），为空表示未配置该渠道
    pushplus_token: Option<String>,
    /// PushPlus 渠道是否启用
    pushplus_enabled: bool,
    threshold_sec: Option<i64>,
    script_path: String,
}

fn claude_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "无法定位 home 目录".into())
}

fn phone_script_path() -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "claudedeck-bark-notify.ps1"
    } else {
        "claudedeck-bark-notify.sh"
    };
    Ok(claude_dir()?.join("hooks").join(name))
}

#[cfg(windows)]
fn hook_command(script: &Path) -> String {
    let p = script.to_string_lossy().replace('\\', "/");
    format!("powershell.exe -NoProfile -ExecutionPolicy Bypass -File {p}")
}

#[cfg(not(windows))]
fn hook_command(script: &Path) -> String {
    format!("bash \"{}\"", script.to_string_lossy())
}

fn group_is_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(HOOK_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// 从 settings.json 三个事件里剔除我们装的 hook group（幂等基础）。
fn remove_our_hooks(root: &mut Value) {
    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for ev in ["UserPromptSubmit", "Stop", "Notification"] {
            if let Some(arr) = hooks.get_mut(ev).and_then(|a| a.as_array_mut()) {
                arr.retain(|g| !group_is_ours(g));
            }
        }
    }
}

fn push_hook(root: &mut Value, event: &str, group: Value) {
    if let Some(obj) = root.as_object_mut() {
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        if let Some(h) = hooks.as_object_mut() {
            let arr = h.entry(event).or_insert_with(|| json!([]));
            if let Some(a) = arr.as_array_mut() {
                a.push(group);
            }
        }
    }
}

fn write_phone_script(
    bark_key: &str,
    bark_enabled: bool,
    pushplus_token: &str,
    pushplus_enabled: bool,
    threshold_ms: i64,
) -> Result<PathBuf, String> {
    let path = phone_script_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建 hooks 目录失败: {e}"))?;
    }
    // 布尔字面量：PowerShell 用 $true/$false，bash 用 true/false。
    #[cfg(windows)]
    let bool_lit = |b: bool| if b { "$true" } else { "$false" };
    #[cfg(not(windows))]
    let bool_lit = |b: bool| if b { "true" } else { "false" };
    let content = PHONE_HOOK_SCRIPT
        .replace("__BARK_KEY__", bark_key)
        .replace("__BARK_ENABLED__", bool_lit(bark_enabled))
        .replace("__PUSHPLUS_TOKEN__", pushplus_token)
        .replace("__PUSHPLUS_ENABLED__", bool_lit(pushplus_enabled))
        .replace("__THRESHOLD_MS__", &threshold_ms.to_string());
    // Windows：前置 UTF-8 BOM（PS 5.1 按 GBK 读中文会乱码）。
    #[cfg(windows)]
    {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(content.as_bytes());
        fs::write(&path, bytes).map_err(|e| format!("写脚本失败: {e}"))?;
    }
    // macOS / Linux：UTF-8 无 BOM，并加可执行位。
    #[cfg(not(windows))]
    {
        fs::write(&path, content.as_bytes()).map_err(|e| format!("写脚本失败: {e}"))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
    }
    Ok(path)
}

fn extract_between(s: &str, start: &str, end: &str) -> Option<String> {
    let i = s.find(start)? + start.len();
    let rest = &s[i..];
    let j = rest.find(end)?;
    Some(rest[..j].to_string())
}

fn settings_has_our_hook() -> bool {
    let Ok(settings) = claude_dir().map(|d| d.join("settings.json")) else {
        return false;
    };
    let Ok(s) = fs::read_to_string(&settings) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&s) else {
        return false;
    };
    root.get("hooks")
        .and_then(|h| h.as_object())
        .map(|h| {
            ["UserPromptSubmit", "Stop", "Notification"].iter().any(|ev| {
                h.get(*ev)
                    .and_then(|a| a.as_array())
                    .map(|arr| arr.iter().any(group_is_ours))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn phone_hook_status() -> PhoneHookStatus {
    let script = phone_script_path().unwrap_or_default();
    let script_exists = script.exists();
    let mut bark_key = None;
    let mut pushplus_token = None;
    let mut threshold_sec = None;
    // 老脚本没有 enabled 标志：key 已填则默认视为启用（向后兼容）
    let mut bark_enabled = true;
    let mut pushplus_enabled = true;
    // 变量行写法因平台而异：PS `$barkKey = '...'`，bash `barkKey='...'`。
    #[cfg(windows)]
    let (mk_bark, mk_pp, mk_thr, mk_be, mk_pe, true_lit) = (
        "$barkKey = '",
        "$pushplusToken = '",
        "$THRESHOLD_MS = ",
        "$barkEnabled = ",
        "$pushplusEnabled = ",
        "$true",
    );
    #[cfg(not(windows))]
    let (mk_bark, mk_pp, mk_thr, mk_be, mk_pe, true_lit) = (
        "barkKey='",
        "pushplusToken='",
        "THRESHOLD_MS=",
        "barkEnabled=",
        "pushplusEnabled=",
        "true",
    );
    if script_exists {
        if let Ok(content) = fs::read_to_string(&script) {
            bark_key = extract_between(&content, mk_bark, "'").filter(|k| !k.is_empty());
            pushplus_token = extract_between(&content, mk_pp, "'").filter(|k| !k.is_empty());
            threshold_sec = extract_between(&content, mk_thr, "\n")
                .and_then(|s| s.trim().parse::<i64>().ok())
                .map(|ms| ms / 1000);
            if let Some(v) = extract_between(&content, mk_be, "\n") {
                bark_enabled = v.trim().eq_ignore_ascii_case(true_lit);
            }
            if let Some(v) = extract_between(&content, mk_pe, "\n") {
                pushplus_enabled = v.trim().eq_ignore_ascii_case(true_lit);
            }
        }
    }
    PhoneHookStatus {
        installed: script_exists && settings_has_our_hook(),
        script_exists,
        bark_key,
        bark_enabled,
        pushplus_token,
        pushplus_enabled,
        threshold_sec,
        script_path: script.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn get_phone_hook_status() -> PhoneHookStatus {
    phone_hook_status()
}

/// 校验渠道名，归一化为 bark / pushplus / ntfy。
fn norm_channel(channel: &str) -> Result<String, String> {
    match channel.trim().to_lowercase().as_str() {
        "bark" => Ok("bark".into()),
        "pushplus" => Ok("pushplus".into()),
        other => Err(format!("不支持的推送渠道: {other}")),
    }
}

#[tauri::command]
fn install_phone_hook(
    bark_key: String,
    bark_enabled: bool,
    pushplus_token: String,
    pushplus_enabled: bool,
    threshold_sec: i64,
) -> Result<PhoneHookStatus, String> {
    let bark_key = bark_key.trim().to_string();
    let pushplus_token = pushplus_token.trim().to_string();
    if bark_key.is_empty() && pushplus_token.is_empty() {
        return Err("至少填一个渠道的 key".into());
    }
    // 至少要有一个「已填 key 且启用」的渠道，否则装了也不会推
    let bark_active = !bark_key.is_empty() && bark_enabled;
    let pushplus_active = !pushplus_token.is_empty() && pushplus_enabled;
    if !bark_active && !pushplus_active {
        return Err("至少启用一个已填 key 的渠道".into());
    }
    // key 不能含单引号(会破坏脚本里 '...' 包裹)
    if bark_key.contains('\'') || pushplus_token.contains('\'') {
        return Err("key 含非法字符（单引号）".into());
    }
    let thr_ms = threshold_sec.max(0) * 1000;
    let script = write_phone_script(
        &bark_key,
        bark_enabled,
        &pushplus_token,
        pushplus_enabled,
        thr_ms,
    )?;

    let settings = claude_dir()?.join("settings.json");
    // 改前备份
    if settings.exists() {
        let bak = claude_dir()?.join("settings.json.claudedeck-bak");
        fs::copy(&settings, &bak).map_err(|e| format!("备份 settings.json 失败: {e}"))?;
    }
    let mut root: Value = if settings.exists() {
        let s = fs::read_to_string(&settings).map_err(|e| format!("读 settings.json 失败: {e}"))?;
        serde_json::from_str(&s)
            .map_err(|e| format!("settings.json 不是合法 JSON，已中止以免破坏: {e}"))?
    } else {
        json!({})
    };
    if !root.is_object() {
        return Err("settings.json 顶层不是对象，已中止".into());
    }

    remove_our_hooks(&mut root); // 幂等：先清旧再加新
    let cmd = hook_command(&script);
    let inner = json!({ "type": "command", "command": cmd, "timeout": 10 });
    push_hook(&mut root, "UserPromptSubmit", json!({ "hooks": [inner.clone()] }));
    push_hook(&mut root, "Stop", json!({ "hooks": [inner.clone()] }));
    push_hook(
        &mut root,
        "Notification",
        json!({ "matcher": "permission_prompt", "hooks": [inner] }),
    );

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&settings, pretty).map_err(|e| format!("写 settings.json 失败: {e}"))?;
    Ok(phone_hook_status())
}

// ── 会话记录保留期（CC cleanupPeriodDays）───────────────────────
// CC 默认在启动时删除 30 天前的会话 jsonl（官方 `cleanupPeriodDays`，缺省 30、最小 1，
// 无官方「关闭」值——「永久」用 36500 天等效）。这里读写 ~/.claude/settings.json 的该键，
// 写回沿用手机推送 hook 的安全模式：先备份、解析校验、只动这一个键、其余配置原样保留。

#[derive(Serialize)]
struct CleanupConfig {
    /// settings.json 里显式配置的天数；None = 未配置（走 CC 默认 30 天）
    period_days: Option<u64>,
}

#[tauri::command]
fn get_cleanup_config() -> Result<CleanupConfig, String> {
    let settings = claude_dir()?.join("settings.json");
    if !settings.exists() {
        return Ok(CleanupConfig { period_days: None });
    }
    let s = fs::read_to_string(&settings).map_err(|e| format!("读 settings.json 失败: {e}"))?;
    let root: Value =
        serde_json::from_str(&s).map_err(|e| format!("settings.json 解析失败: {e}"))?;
    Ok(CleanupConfig {
        period_days: root.get("cleanupPeriodDays").and_then(|v| v.as_u64()),
    })
}

/// 设置保留天数；days=None 表示删掉该键、恢复 CC 默认（30 天）。
#[tauri::command]
fn set_cleanup_period(days: Option<u64>) -> Result<(), String> {
    if let Some(n) = days {
        if n == 0 {
            return Err("天数最小为 1（CC 官方限制）".into());
        }
        if n > 36500 {
            return Err("天数上限 36500（= 100 年，等效永久）".into());
        }
    }
    let settings = claude_dir()?.join("settings.json");
    if settings.exists() {
        let bak = claude_dir()?.join("settings.json.claudedeck-bak");
        fs::copy(&settings, &bak).map_err(|e| format!("备份 settings.json 失败: {e}"))?;
    }
    let mut root: Value = if settings.exists() {
        let s = fs::read_to_string(&settings).map_err(|e| format!("读 settings.json 失败: {e}"))?;
        serde_json::from_str(&s)
            .map_err(|e| format!("settings.json 不是合法 JSON，已中止以免破坏: {e}"))?
    } else {
        json!({})
    };
    let obj = root
        .as_object_mut()
        .ok_or("settings.json 顶层不是对象，已中止")?;
    match days {
        Some(n) => {
            obj.insert("cleanupPeriodDays".into(), json!(n));
        }
        None => {
            obj.remove("cleanupPeriodDays");
        }
    }
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&settings, pretty).map_err(|e| format!("写 settings.json 失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn uninstall_phone_hook() -> Result<PhoneHookStatus, String> {
    let settings = claude_dir()?.join("settings.json");
    if settings.exists() {
        let s = fs::read_to_string(&settings).map_err(|e| format!("读 settings.json 失败: {e}"))?;
        let mut root: Value =
            serde_json::from_str(&s).map_err(|e| format!("settings.json 解析失败: {e}"))?;
        let bak = claude_dir()?.join("settings.json.claudedeck-bak");
        let _ = fs::copy(&settings, &bak);
        remove_our_hooks(&mut root);
        let pretty = serde_json::to_string_pretty(&root).map_err(|e| format!("序列化失败: {e}"))?;
        fs::write(&settings, pretty).map_err(|e| format!("写 settings.json 失败: {e}"))?;
    }
    let _ = fs::remove_file(phone_script_path()?);
    Ok(phone_hook_status())
}

#[tauri::command]
fn test_phone_push(channel: String, key: String) -> Result<(), String> {
    let channel = norm_channel(&channel)?;
    let key = key.trim();
    if key.is_empty() {
        return Err("密钥 / 主题不能为空".into());
    }
    let title = "🔔 ClaudeDeck 测试推送";
    // 带时间戳：PushPlus 等渠道会拒绝「频繁推送相同内容」，每次唯一才能反复测
    let body = format!("能收到这条就说明推送配好了 · {}", now_ms());

    // Rust 的 Command 在 Windows 走宽字符，中文参数不会乱码，可直接 --data-urlencode
    let args: Vec<String> = match channel.as_str() {
        "pushplus" => vec![
            "-s".into(),
            "-X".into(),
            "POST".into(),
            "https://www.pushplus.plus/send".into(),
            "--data-urlencode".into(),
            format!("token={key}"),
            "--data-urlencode".into(),
            format!("title={title}"),
            "--data-urlencode".into(),
            format!("content={body}"),
        ],
        _ => vec![
            "-s".into(),
            "-X".into(),
            "POST".into(),
            format!("https://api.day.app/{key}"),
            "--data-urlencode".into(),
            format!("title={title}"),
            "--data-urlencode".into(),
            format!("body={body}"),
            "--data-urlencode".into(),
            "group=ClaudeDeck".into(),
            "--data-urlencode".into(),
            "sound=birdsong".into(),
        ],
    };

    let out = silent_command(CURL_BIN)
        .args(&args)
        .output()
        .map_err(|e| format!("调用 curl 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "curl 退出码非 0: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let resp = String::from_utf8_lossy(&out.stdout);
    // bark / pushplus 成功返回含 "code":200
    if resp.contains("\"code\":200") {
        Ok(())
    } else {
        Err(format!("渠道返回异常: {resp}"))
    }
}

/// 后端常驻通知线程的逐会话状态。
struct Tracked {
    status: Option<String>,
    active: bool,
    busy_since: i64,
}

/// 常驻后端线程：独立轮询会话状态、检测翻转、直接发系统通知。
///
/// **关键**：放后端而非前端，是因为 webview 在后台会被限流/冻结 setInterval，
/// 导致前端轮询停摆、漏发通知。后端线程不受前后台影响。
fn notifier_loop(app: tauri::AppHandle, cfg: Arc<Mutex<NotifyConfig>>) {
    let mut prev: HashMap<String, Tracked> = HashMap::new();
    let mut seeded = false;

    loop {
        let now = now_ms();
        let c = cfg.lock().map(|g| g.clone()).unwrap_or_default();
        let views = read_session_views().unwrap_or_default();
        let mut next: HashMap<String, Tracked> = HashMap::new();

        for v in &views {
            if v.parse_error.is_some() {
                continue;
            }
            let active = matches!(v.status.as_deref(), Some("busy") | Some("shell"));
            // 进入活动态记起点；活动态内部 busy↔shell 切换保持起点不变。
            let busy_since = if active {
                match prev.get(&v.file) {
                    Some(p) if p.active => p.busy_since,
                    _ => now,
                }
            } else {
                0
            };

            if seeded && c.enabled && v.alive {
                let p = prev.get(&v.file);
                let was_active = p.map(|p| p.active).unwrap_or(false);
                let was_waiting =
                    p.map(|p| p.status.as_deref() == Some("waiting")).unwrap_or(false);

                // 长任务完成：活动 → idle，且 busy 时长达阈值
                if was_active && v.status.as_deref() == Some("idle") && c.done {
                    let dur = now - p.map(|p| p.busy_since).unwrap_or(now);
                    if dur >= c.threshold_ms {
                        let proj = v.project.clone().unwrap_or_else(|| "会话".into());
                        let _ = app
                            .notification()
                            .builder()
                            .title(format!("✅ {proj} · 任务完成"))
                            .body(format!("用时 {}", fmt_dur(dur)))
                            .show();
                        let _ = app.emit("notify-ding", "done");
                    }
                }

                // 等待输入：进入 waiting（不受阈值限制，立即提醒）
                if v.status.as_deref() == Some("waiting") && !was_waiting && c.waiting {
                    let proj = v.project.clone().unwrap_or_else(|| "会话".into());
                    let _ = app
                        .notification()
                        .builder()
                        .title(format!("⏳ {proj} · 等待你的输入"))
                        .body(v.cwd.clone().unwrap_or_default())
                        .show();
                    let _ = app.emit("notify-ding", "waiting");
                }
            }

            next.insert(
                v.file.clone(),
                Tracked {
                    status: v.status.clone(),
                    active,
                    busy_since,
                },
            );
        }

        prev = next;
        seeded = true;
        std::thread::sleep(Duration::from_millis(NOTIFY_POLL_MS));
    }
}

/// 从托盘唤回主窗口：取消最小化 + 显示 + 置前。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = Arc::new(Mutex::new(NotifyConfig::default()));
    // 关窗行为：默认隐藏到托盘常驻（前端可下发改成关窗即退出）。
    let close_to_tray = Arc::new(AtomicBool::new(true));

    tauri::Builder::default()
        // 单实例：再次启动（双击图标 / 命令行）不开新窗口，把已运行实例唤回置前。
        // 必须作为第一个注册的插件才稳定生效。本 app 关窗/自启都会藏托盘，
        // 第二次启动正好等价于「从后台把它叫出来」。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // 开机自启：定时开窗需要 app 到点在跑。自启时带 --autostart 参数（启动即隐藏到托盘）。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // 官方自动更新：latest.json + 签名验证；process 插件供更新后 relaunch。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(cfg.clone())
        .manage(close_to_tray.clone())
        .setup(move |app| {
            // 隐藏诊断：`--check-update-cli` 直接跑官方 updater 检查，结果写
            // %TEMP%\claudedeck-update-check.log 后退出（GUI 子系统无控制台，只能落盘）。
            // 用于排查「插件检查失败静默退回下载页」时拿真实错误。
            if std::env::args().any(|a| a == "--check-update-cli") {
                use tauri_plugin_updater::UpdaterExt;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let msg = match handle.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(u)) => {
                                format!("UPDATE FOUND: {} -> {}", u.current_version, u.version)
                            }
                            Ok(None) => "NO UPDATE".to_string(),
                            Err(e) => format!("CHECK ERROR: {e:?}"),
                        },
                        Err(e) => format!("UPDATER INIT ERROR: {e:?}"),
                    };
                    let _ = fs::write(
                        std::env::temp_dir().join("claudedeck-update-check.log"),
                        &msg,
                    );
                    handle.exit(0);
                });
            }

            // 注册 AUMID + 开始菜单快捷方式，让免安装 / dev 的 toast 通知显示 ClaudeDeck。
            // app_id 必须 == tauri.conf.json 的 identifier，否则与通知插件用的 AUMID 不一致。
            #[cfg(windows)]
            if let Err(e) = aumid::ensure_aumid_shortcut("com.xueyu.claudedeck", "ClaudeDeck") {
                eprintln!("AUMID 设置失败: {e}");
            }
            let handle = app.handle().clone();
            let cfg_thread = cfg.clone();
            std::thread::spawn(move || notifier_loop(handle, cfg_thread));

            // 定时开窗调度线程：到点跑 claude -p 开启 5h 窗口。
            let sched_handle = app.handle().clone();
            std::thread::spawn(move || scheduler_loop(sched_handle));

            // 开机自启拉起时（带 --autostart），启动即隐藏到托盘，后台跑调度、不弹窗打扰。
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            // 系统托盘：关窗最小化到托盘后，左键托盘图标唤回，菜单可真正退出。
            // 让通知 / 提示音 / 后端通知线程在后台常驻（关窗不再杀进程）。
            let show_i = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 ClaudeDeck", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ClaudeDeck — Claude Code 控制台")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗行为按设置走：隐藏到托盘（默认，真正退出走托盘菜单）或直接退出。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let hide = window
                    .state::<Arc<AtomicBool>>()
                    .load(Ordering::Relaxed);
                if hide {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            get_env_status,
            get_platform,
            check_for_update,
            force_quit_and_relaunch,
            get_cleanup_config,
            set_cleanup_period,
            list_memory_projects,
            list_memories,
            read_global_md,
            save_memory,
            save_global_md,
            delete_memory,
            list_trash,
            restore_trash,
            purge_trash,
            read_project_md,
            save_project_md,
            delete_empty_memory_dir,
            list_skills,
            list_project_skills,
            skill_projects_list,
            skill_projects_add,
            skill_projects_remove,
            read_skill,
            list_skill_files,
            open_skill_dir,
            set_skill_tags,
            set_skill_note,
            delete_skill,
            list_skill_trash,
            restore_skill_trash,
            purge_skill_trash,
            launcher_get_config,
            launcher_add_dir,
            launcher_remove_dir,
            launcher_save_precmd,
            launcher_set_use_wt,
            launcher_launch,
            launcher_resume,
            favorites_list,
            favorites_add,
            favorites_remove,
            schedule_get_config,
            schedule_set_enabled,
            schedule_set_prompt,
            schedule_add_trigger,
            schedule_remove_trigger,
            schedule_toggle_trigger,
            schedule_run_now,
            schedule_get_autostart,
            schedule_set_autostart,
            set_close_to_tray,
            set_notify_config,
            get_ui_prefs,
            set_ui_pref,
            get_phone_hook_status,
            install_phone_hook,
            uninstall_phone_hook,
            test_phone_push,
            list_recent_sessions,
            search_sessions,
            read_session_tail,
            read_session_full,
            export_session_md,
            delete_session,
            usage::list_token_usage,
            usage::list_session_costs,
            usage::list_pricing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_gt_basic() {
        assert!(version_gt("0.9.2", "0.9.1"));
        assert!(version_gt("0.10.0", "0.9.9"));
        assert!(version_gt("1.0.0", "0.9.9"));
        assert!(!version_gt("0.9.1", "0.9.1")); // 相等不算新
        assert!(!version_gt("0.9.0", "0.9.1")); // 旧不算新
    }

    #[test]
    fn version_gt_edge() {
        // 缺位补 0：1.0 == 1.0.0
        assert!(!version_gt("1.0", "1.0.0"));
        assert!(version_gt("1.0.1", "1.0"));
        // 容忍后缀：取前导数字
        assert!(version_gt("0.9.2-beta", "0.9.1"));
        assert!(!version_gt("0.9.1", "0.9.1-rc1"));
    }

    // 格式 A：顶层平铺 type（本机较早格式）
    #[test]
    fn parse_flat_type() {
        let src = "---\nname: 重要旧版文件先改名备份再覆盖\ndescription: 覆盖前先改名备份\ntype: feedback\noriginSessionId: abc\n---\n正文内容\n关联 feedback_check.md";
        let n = parse_memory("x.md".into(), src, 0);
        assert_eq!(n.name.as_deref(), Some("重要旧版文件先改名备份再覆盖"));
        assert_eq!(n.description.as_deref(), Some("覆盖前先改名备份"));
        assert_eq!(n.mem_type.as_deref(), Some("feedback"));
        assert!(n.body.starts_with("正文内容"));
        assert!(n.parse_error.is_none());
    }

    // 格式 B：metadata 嵌套 type + description 带引号转义
    #[test]
    fn parse_nested_type() {
        let src = "---\nname: feedback-xhs-no-account-search\ndescription: \"不要走\\\"曹少账号\\\"通道\"\nmetadata: \n  node_type: memory\n  type: feedback\n  originSessionId: xyz\n---\n正文";
        let n = parse_memory("y.md".into(), src, 0);
        assert_eq!(n.name.as_deref(), Some("feedback-xhs-no-account-search"));
        assert_eq!(n.description.as_deref(), Some("不要走\"曹少账号\"通道"));
        assert_eq!(n.mem_type.as_deref(), Some("feedback"));
    }

    // 顶层 type 优先于 metadata 内的 type
    #[test]
    fn top_level_type_wins() {
        let src = "---\nname: a\ntype: user\nmetadata:\n  type: feedback\n---\nbody";
        let n = parse_memory("z.md".into(), src, 0);
        assert_eq!(n.mem_type.as_deref(), Some("user"));
    }

    #[test]
    fn extract_links_dedup() {
        let body = "见 [[foo]] 和 [[bar]]，又见 [[foo]]";
        assert_eq!(extract_links(body), vec!["foo", "bar"]);
    }

    #[test]
    fn no_frontmatter_all_body() {
        let n = parse_memory("n.md".into(), "没有 frontmatter 的纯正文", 0);
        assert!(n.name.is_none());
        assert!(n.mem_type.is_none());
        assert_eq!(n.body, "没有 frontmatter 的纯正文");
    }
}
