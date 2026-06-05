use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

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
            let handle = app.handle().clone();
            let cfg_thread = cfg.clone();
            std::thread::spawn(move || notifier_loop(handle, cfg_thread));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_sessions, set_notify_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
