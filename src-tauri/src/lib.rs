use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

/// busy 会话超过这个空闲时长（毫秒）判为疑似卡死。RESEARCH §3 初值。
const STUCK_THRESHOLD_MS: i64 = 60_000;

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
#[derive(Debug, Serialize)]
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

/// 读取 `~/.claude/sessions/*.json`，解析为会话列表。
///
/// 解析失败的单个文件降级为带 `parse_error` 的记录而非整体报错（RESEARCH §3 失败降级）。
#[tauri::command]
fn list_sessions() -> Result<Vec<SessionView>, String> {
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

fn busy_rank(status: &Option<String>) -> u8 {
    match status.as_deref() {
        Some("busy") => 2,
        Some("idle") => 1,
        _ => 0,
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_sessions])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
