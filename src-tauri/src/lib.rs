use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sysinfo::{Pid, System};
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

mod aumid;

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
    // new_all() 会刷新进程表，用于 pid 判活（RESEARCH §7 风险 5：文件残留但进程已死）。
    let sys = System::new_all();

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
                out.push(error_view(file, format!("读文件失败: {e}")));
                continue;
            }
        };

        match serde_json::from_str::<RawSession>(&content) {
            Ok(raw) => {
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
            Err(e) => out.push(error_view(file, format!("JSON 解析失败: {e}"))),
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

/// hook 脚本模板。`__BARK_KEY__` / `__THRESHOLD_MS__` 安装时替换。
/// 写盘时前置 UTF-8 BOM，否则 Windows PowerShell 5.1 按 GBK 读中文会乱码。
const PHONE_HOOK_SCRIPT: &str = r##"# ClaudeDeck — Claude Code hook → Bark 手机推送
# 本文件由 ClaudeDeck 自动生成与管理，请勿手改（在应用里改 key / 阈值即可）。
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
$url = "https://api.day.app/$barkKey"
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
$form = "title=$(Enc $title)&body=$(Enc $body)&group=ClaudeDeck&sound=$sound"
& curl.exe -s -X POST $url --data $form > $null
exit 0
"##;

/// 手机 hook 当前状态，回传前端用于回填表单 + 显示开关。
#[derive(Debug, Serialize)]
struct PhoneHookStatus {
    installed: bool,
    script_exists: bool,
    bark_key: Option<String>,
    threshold_sec: Option<i64>,
    script_path: String,
}

fn claude_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "无法定位 home 目录".into())
}

fn phone_script_path() -> Result<PathBuf, String> {
    Ok(claude_dir()?
        .join("hooks")
        .join("claudedeck-bark-notify.ps1"))
}

fn hook_command(script: &Path) -> String {
    let p = script.to_string_lossy().replace('\\', "/");
    format!("powershell.exe -NoProfile -ExecutionPolicy Bypass -File {p}")
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

fn write_phone_script(bark_key: &str, threshold_ms: i64) -> Result<PathBuf, String> {
    let path = phone_script_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建 hooks 目录失败: {e}"))?;
    }
    let content = PHONE_HOOK_SCRIPT
        .replace("__BARK_KEY__", bark_key)
        .replace("__THRESHOLD_MS__", &threshold_ms.to_string());
    // 前置 UTF-8 BOM
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(content.as_bytes());
    fs::write(&path, bytes).map_err(|e| format!("写脚本失败: {e}"))?;
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
    let mut threshold_sec = None;
    if script_exists {
        if let Ok(content) = fs::read_to_string(&script) {
            bark_key = extract_between(&content, "$barkKey = '", "'").filter(|k| !k.is_empty());
            threshold_sec = extract_between(&content, "$THRESHOLD_MS = ", "\n")
                .and_then(|s| s.trim().parse::<i64>().ok())
                .map(|ms| ms / 1000);
        }
    }
    PhoneHookStatus {
        installed: script_exists && settings_has_our_hook(),
        script_exists,
        bark_key,
        threshold_sec,
        script_path: script.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn get_phone_hook_status() -> PhoneHookStatus {
    phone_hook_status()
}

#[tauri::command]
fn install_phone_hook(bark_key: String, threshold_sec: i64) -> Result<PhoneHookStatus, String> {
    let key = bark_key.trim().to_string();
    if key.is_empty() {
        return Err("Bark key 不能为空".into());
    }
    let thr_ms = threshold_sec.max(0) * 1000;
    let script = write_phone_script(&key, thr_ms)?;

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
fn test_phone_push(bark_key: String) -> Result<(), String> {
    let key = bark_key.trim();
    if key.is_empty() {
        return Err("Bark key 不能为空".into());
    }
    let url = format!("https://api.day.app/{key}");
    let out = Command::new("curl.exe")
        .args([
            "-s",
            "-X",
            "POST",
            &url,
            "--data-urlencode",
            "title=🔔 ClaudeDeck 测试推送",
            "--data-urlencode",
            "body=能收到这条就说明 Bark 配好了",
            "--data-urlencode",
            "group=ClaudeDeck",
            "--data-urlencode",
            "sound=birdsong",
        ])
        .output()
        .map_err(|e| format!("调用 curl 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "curl 退出码非 0: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let resp = String::from_utf8_lossy(&out.stdout);
    if resp.contains("\"code\":200") {
        Ok(())
    } else {
        Err(format!("Bark 返回异常: {resp}"))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = Arc::new(Mutex::new(NotifyConfig::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(cfg.clone())
        .setup(move |app| {
            // 注册 AUMID + 开始菜单快捷方式，让免安装 / dev 的 toast 通知显示 ClaudeDeck。
            // app_id 必须 == tauri.conf.json 的 identifier，否则与通知插件用的 AUMID 不一致。
            #[cfg(windows)]
            if let Err(e) = aumid::ensure_aumid_shortcut("com.xueyu.claudedeck", "ClaudeDeck") {
                eprintln!("AUMID 设置失败: {e}");
            }
            let handle = app.handle().clone();
            let cfg_thread = cfg.clone();
            std::thread::spawn(move || notifier_loop(handle, cfg_thread));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            set_notify_config,
            get_phone_hook_status,
            install_phone_hook,
            uninstall_phone_hook,
            test_phone_push
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
