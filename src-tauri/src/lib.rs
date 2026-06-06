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

/// 检测 `curl.exe` 是否在 PATH 中可用（手机推送依赖）。
fn curl_available() -> bool {
    Command::new("curl.exe")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

/// 从编码目录名尽力反推友好名：取 `Desktop-` 之后的部分，否则原样。
/// 编码规则有歧义（项目名本身含 `-` 时无法可靠还原），故仅作显示美化。
fn decode_project_label(dir: &str) -> String {
    if let Some(idx) = dir.find("Desktop-") {
        let tail = &dir[idx + "Desktop-".len()..];
        if !tail.is_empty() {
            return tail.to_string();
        }
    }
    dir.to_string()
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
        let label = decode_project_label(&dir);
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
            get_env_status,
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
            set_notify_config,
            get_phone_hook_status,
            install_phone_hook,
            uninstall_phone_hook,
            test_phone_push
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
