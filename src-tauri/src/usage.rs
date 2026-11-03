//! Token 用量 / 计费统计。
//!
//! 数据源：`~/.claude/projects/<编码路径>/<sessionId>.jsonl`，每行一个事件，
//! assistant 行的 `message.usage` 携带 token 计数。一个 jsonl 文件 = 一个会话。
//!
//! 计费方法学（对照 ccusage 金标准 + 本机实测打磨，见 RESEARCH / 路线图）：
//!   - 费率表**硬编码**（与 ccusage 内置值逐位一致，离线优先；只覆盖 Claude 系）。
//!   - 缓存写入**拆 1h / 5m**：ccusage 把 cache_creation 整块按 1.25× 算、不分 1h；
//!     但本机 Claude Code 确实在用 1h 缓存（真实 API 价 2×），故按
//!     `ephemeral_5m(1.25×)` / `ephemeral_1h(2×)` 分别计价，比 ccusage 更准。
//!     老 jsonl 无拆分字段时整块按 5m(1.25×) 兜底（向后兼容）。
//!   - 全局去重 `message.id + requestId`（resume / fork 会把同一条写进多个文件）。
//!   - 跳过 `<synthetic>` 与无 usage / 无 model 的行。
//!   - 模型名做分隔符归一化（`.`/`@`→`-`、剥 provider 前缀）+ 族 fallback。

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// 单模型每 token 费率（美元）。cache_5m = 1.25×input，cache_1h = 2×input，
/// cache_read = 0.1×input（例外：Fable/Mythos 5.1 为 0.025×，Opus 5.5 为 0.05×）——
/// 全部写成显式常量，便于单测对拍与一眼核对。
#[derive(Debug, Clone, Copy)]
struct Pricing {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
}

/// 按模型 id 查费率。先归一化，再按族（最具体在前）匹配。
///
/// 注意顺序：`claude-opus-5-5` 也含子串 `opus-5`，`claude-opus-4-8` 也含子串 `opus-4`，
/// 所以先判 5-5，再判 5 / 4-5…4-8 这些「新 opus（$5/$25）」，最后落到「老 opus-4（$15/$75）」。
fn find_pricing(model: &str) -> Option<Pricing> {
    let m = normalize_model(model);
    if m.contains("synthetic") {
        return None;
    }

    // ×1e-6 写法：5e-6 = $5 / 1M token
    const OPUS_NEW: Pricing = Pricing {
        input: 5e-6,
        output: 25e-6,
        cache_read: 0.5e-6,
        cache_write_5m: 6.25e-6,
        cache_write_1h: 10e-6,
    };
    // Opus 5.5 = $4/$20，缓存读 0.05×（$0.20）
    const OPUS_55: Pricing = Pricing {
        input: 4e-6,
        output: 20e-6,
        cache_read: 0.2e-6,
        cache_write_5m: 5e-6,
        cache_write_1h: 8e-6,
    };
    const OPUS_OLD: Pricing = Pricing {
        input: 15e-6,
        output: 75e-6,
        cache_read: 1.5e-6,
        cache_write_5m: 18.75e-6,
        cache_write_1h: 30e-6,
    };
    const SONNET: Pricing = Pricing {
        input: 3e-6,
        output: 15e-6,
        cache_read: 0.3e-6,
        cache_write_5m: 3.75e-6,
        cache_write_1h: 6e-6,
    };
    // Sonnet 5 / 5.5 = $2/$10（Sonnet 5 的 intro 价已转为标准价）
    const SONNET_5: Pricing = Pricing {
        input: 2e-6,
        output: 10e-6,
        cache_read: 0.2e-6,
        cache_write_5m: 2.5e-6,
        cache_write_1h: 4e-6,
    };
    const HAIKU_NEW: Pricing = Pricing {
        input: 1e-6,
        output: 5e-6,
        cache_read: 0.1e-6,
        cache_write_5m: 1.25e-6,
        cache_write_1h: 2e-6,
    };
    const HAIKU_35: Pricing = Pricing {
        input: 0.8e-6,
        output: 4e-6,
        cache_read: 0.08e-6,
        cache_write_5m: 1.0e-6,
        cache_write_1h: 1.6e-6,
    };
    const HAIKU_3: Pricing = Pricing {
        input: 0.25e-6,
        output: 1.25e-6,
        cache_read: 0.03e-6,
        cache_write_5m: 0.3e-6,
        cache_write_1h: 0.5e-6,
    };
    // Fable 5（含同价的 Mythos 5，仅 Project Glasswing）= $10/$50；
    // 缓存派生与其它族一致：读 = input×0.1，写 5m = ×1.25，写 1h = ×2。
    const FABLE: Pricing = Pricing {
        input: 10e-6,
        output: 50e-6,
        cache_read: 1e-6,
        cache_write_5m: 12.5e-6,
        cache_write_1h: 20e-6,
    };
    // Fable 5.1 / Mythos 5.1：输入输出同 Fable 5，缓存读降到 0.025×（$0.25）
    const FABLE_51: Pricing = Pricing {
        cache_read: 0.25e-6,
        ..FABLE
    };

    // fable / mythos（同族，且不含 opus/sonnet/haiku 子串，先判无歧义）
    if m.contains("fable") || m.contains("mythos") {
        if m.contains("fable-5-1") || m.contains("mythos-5-1") {
            return Some(FABLE_51);
        }
        return Some(FABLE);
    }
    // opus
    if m.contains("opus") {
        if m.contains("opus-5-5") {
            return Some(OPUS_55);
        }
        if m.contains("opus-5")
            || m.contains("opus-4-5")
            || m.contains("opus-4-6")
            || m.contains("opus-4-7")
            || m.contains("opus-4-8")
        {
            return Some(OPUS_NEW);
        }
        // opus-4-0 / opus-4-1 / opus-4 / opus-3 → 老价
        return Some(OPUS_OLD);
    }
    // sonnet：5 / 5.5 为 $2/$10，4.x / 3.x 为 $3/$15
    if m.contains("sonnet") {
        if m.contains("sonnet-5") {
            return Some(SONNET_5);
        }
        return Some(SONNET);
    }
    // haiku
    if m.contains("haiku") {
        if m.contains("haiku-4") {
            return Some(HAIKU_NEW);
        }
        if m.contains("haiku-3-5") {
            return Some(HAIKU_35);
        }
        return Some(HAIKU_3);
    }
    None
}

/// ISO8601 时间戳 → **本地时区**日期串 `YYYY-MM-DD`。
/// 用本地时区（非 UTC）分桶：跨午夜的会话按使用者当地的"那一天"归属，
/// 与 ccusage 的 `format_date_tz` 口径一致。解析失败返回 None（不计入日桶）。
fn local_date(ts: &str) -> Option<String> {
    use chrono::{DateTime, Local};
    let dt = DateTime::parse_from_rfc3339(ts).ok()?;
    Some(dt.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

/// 归一化模型 id：小写、`.`/`@`→`-`、剥 `provider/` 前缀与 `anthropic.` 前缀。
/// 例：`anthropic/claude-opus-4.8` → `claude-opus-4-8`。
fn normalize_model(model: &str) -> String {
    let lower = model.to_lowercase();
    // 取最后一段 provider 路径（openrouter/anthropic/claude-... → claude-...）
    let tail = lower.rsplit('/').next().unwrap_or(&lower);
    let tail = tail.strip_prefix("anthropic.").unwrap_or(tail);
    tail.replace(['.', '@'], "-")
}

// ── jsonl 原始结构（全字段 optional，坏行跳过不影响整体）─────────────

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawEntry {
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    message: Option<RawMessage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<RawUsage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_creation: Option<RawCacheCreation>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawCacheCreation {
    ephemeral_5m_input_tokens: Option<u64>,
    ephemeral_1h_input_tokens: Option<u64>,
}

/// 一条标准化后的用量记录（去重 + 取数后）。
#[derive(Debug, Clone, Copy, Default)]
struct Tokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write_5m += o.cache_write_5m;
        self.cache_write_1h += o.cache_write_1h;
    }
    fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write_5m + self.cache_write_1h
    }
    /// 用某模型费率算这批 token 的美元成本。无费率返回 None。
    fn cost(&self, model: &str) -> Option<f64> {
        let p = find_pricing(model)?;
        Some(
            self.input as f64 * p.input
                + self.output as f64 * p.output
                + self.cache_read as f64 * p.cache_read
                + self.cache_write_5m as f64 * p.cache_write_5m
                + self.cache_write_1h as f64 * p.cache_write_1h,
        )
    }
}

/// 从 usage 拆出 5m / 1h 缓存写入。详见模块头注释（拆分口径）。
fn split_cache(u: &RawUsage) -> (u64, u64) {
    match &u.cache_creation {
        Some(d) if d.ephemeral_5m_input_tokens.is_some() || d.ephemeral_1h_input_tokens.is_some() => {
            (
                d.ephemeral_5m_input_tokens.unwrap_or(0),
                d.ephemeral_1h_input_tokens.unwrap_or(0),
            )
        }
        // 老格式无拆分：整块算 5m(1.25×) 兜底
        _ => (u.cache_creation_input_tokens.unwrap_or(0), 0),
    }
}

// ── 对外结构 ──────────────────────────────────────────────────

/// 单会话用量聚合。
#[derive(Debug, Serialize)]
pub(crate) struct SessionUsage {
    /// 会话 id（= jsonl 文件名去扩展名）
    session_id: String,
    /// 编码后的项目目录名
    project: String,
    /// 友好项目名
    project_label: String,
    cwd: Option<String>,
    /// 该会话出现过的模型（去重，按出现）
    models: Vec<String>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    total_tokens: u64,
    cost: f64,
    /// 计入的 assistant 消息条数（去重后）
    message_count: u64,
    first_ts: Option<String>,
    last_ts: Option<String>,
    /// 该会话存在无法定价的模型（成本被低估）
    has_unpriced: bool,
}

/// 日内拆分条目（key = 模型名或 session_id）。周期速览行展开的「计费详情」用；
/// 周 / 月的详情由前端把区间内各日的条目按 key 再聚合。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DaySlice {
    key: String,
    total_tokens: u64,
    cost: f64,
    message_count: u64,
}

/// 单日用量聚合（本地时区日期）。周 / 月速览由前端在此基础上再聚合。
#[derive(Debug, Serialize)]
pub(crate) struct DayUsage {
    /// 本地日期 `YYYY-MM-DD`
    date: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    total_tokens: u64,
    cost: f64,
    message_count: u64,
    models: Vec<String>,
    /// 当日按模型拆分（cost 高→低）
    by_model: Vec<DaySlice>,
    /// 当日按会话拆分（cost 高→低；前端用 session_id 关联会话明细拿项目名）
    by_session: Vec<DaySlice>,
}

/// 单模型用量聚合（跨所有会话）。
#[derive(Debug, Serialize)]
pub(crate) struct ModelUsage {
    model: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    total_tokens: u64,
    cost: f64,
    /// 该模型有无硬编码费率（false = 成本按 0 计、计入 unpriced）
    priced: bool,
}

/// 完整用量报告。
#[derive(Debug, Serialize)]
pub(crate) struct UsageReport {
    sessions: Vec<SessionUsage>,
    by_model: Vec<ModelUsage>,
    /// 按本地日期升序的日桶（前端再聚合出周 / 月）
    daily: Vec<DayUsage>,
    total_input: u64,
    total_output: u64,
    total_cache_read: u64,
    total_cache_write_5m: u64,
    total_cache_write_1h: u64,
    total_tokens: u64,
    total_cost: f64,
    session_count: usize,
    scanned_files: usize,
    /// 扫到但无硬编码费率的模型名（前端给「计价覆盖」提示）
    unpriced_models: Vec<String>,
}

/// 聚合用的可变累加器（建报告时用，最后转成 Serialize 结构）。
#[derive(Default)]
struct Agg {
    tokens: Tokens,
    cost: f64,
    message_count: u64,
}

/// 日桶累加器。
#[derive(Default)]
struct DayAcc {
    tokens: Tokens,
    cost: f64,
    message_count: u64,
    models: Vec<Arc<str>>,
    by_model: HashMap<Arc<str>, Agg>,
    by_session: HashMap<Arc<str>, Agg>,
}

// ── 逐文件解析缓存 ─────────────────────────────────────────────
//
// 历史会话的 jsonl 写完就不再变，没必要每次都把全部记录（本机 2 GB 级）重读一遍。
// 每个文件解析一次后记住「文件大小 + 修改时间 + 解析出的记录」，两者都没变就直接复用，
// 只有正在跑的会话（文件在增长）才重读。
//
// 缓存的是**去重前**的逐条记录：跨文件去重（resume / fork 会把同一条写进多个文件）
// 仍在每次汇总时按目录遍历顺序重做，结果与不缓存时一致。

/// 一条 usage 记录（解析时已算好费用与本地日期）。
struct Rec {
    /// `message.id + requestId` 的 128 位指纹；缺任一为 None（不参与去重）
    dedup: Option<[u64; 2]>,
    model: Arc<str>,
    tokens: Tokens,
    cost: f64,
    priced: bool,
    /// 本地时区日期 `YYYY-MM-DD`
    day: Option<Arc<str>>,
    ts: Option<Box<str>>,
    cwd: Option<Arc<str>>,
}

struct FileCache {
    size: u64,
    mtime: Option<SystemTime>,
    recs: Vec<Rec>,
}

fn file_cache() -> &'static Mutex<HashMap<PathBuf, FileCache>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, FileCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 去重键指纹：两个不同种子的 64 位哈希拼成 128 位（13 万条量级下撞车概率可忽略），
/// 比存原字符串省内存。缓存只活在进程内，哈希无需跨版本稳定。
fn dedup_key(mid: &str, rid: &str) -> [u64; 2] {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let h = |seed: u8| {
        let mut s = DefaultHasher::new();
        seed.hash(&mut s);
        mid.hash(&mut s);
        rid.hash(&mut s);
        s.finish()
    };
    [h(0), h(1)]
}

/// 同值共用一个 Arc（一个文件里模型 / 日期 / cwd 只有寥寥几种），省内存。
fn intern(pool: &mut Vec<Arc<str>>, v: &str) -> Arc<str> {
    if let Some(a) = pool.iter().rev().find(|a| &***a == v) {
        return a.clone();
    }
    let a: Arc<str> = Arc::from(v);
    pool.push(a.clone());
    a
}

/// 解析一个 jsonl 的全部 usage 行。打不开返回 None（本次跳过、不进缓存，下次再试）。
fn parse_file(path: &Path) -> Option<Vec<Rec>> {
    let file = File::open(path).ok()?;
    let mut recs = Vec::new();
    let mut models: Vec<Arc<str>> = Vec::new();
    let mut days: Vec<Arc<str>> = Vec::new();
    let mut cwds: Vec<Arc<str>> = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<RawEntry>(line) else {
            continue; // 坏行跳过
        };
        let Some(msg) = entry.message else { continue };
        let Some(usage) = msg.usage else { continue };
        let Some(model) = msg.model.filter(|m| !m.is_empty()) else {
            continue;
        };
        if model == "<synthetic>" {
            continue;
        }
        let dedup = match (msg.id.as_deref(), entry.request_id.as_deref()) {
            (Some(mid), Some(rid)) => Some(dedup_key(mid, rid)),
            _ => None,
        };
        let (c5, c1) = split_cache(&usage);
        let tokens = Tokens {
            input: usage.input_tokens.unwrap_or(0),
            output: usage.output_tokens.unwrap_or(0),
            cache_read: usage.cache_read_input_tokens.unwrap_or(0),
            cache_write_5m: c5,
            cache_write_1h: c1,
        };
        // 零用量又不带去重键的行汇总时必被跳过，不存；带去重键的要留着
        // （它会挡掉后面同键的行，与逐行现算时的行为一致）。
        if tokens.total() == 0 && dedup.is_none() {
            continue;
        }
        recs.push(Rec {
            dedup,
            priced: find_pricing(&model).is_some(),
            cost: tokens.cost(&model).unwrap_or(0.0),
            model: intern(&mut models, &model),
            tokens,
            day: entry
                .timestamp
                .as_deref()
                .and_then(local_date)
                .map(|d| intern(&mut days, &d)),
            ts: entry.timestamp.map(String::into_boxed_str),
            cwd: entry.cwd.as_deref().map(|c| intern(&mut cwds, c)),
        });
    }
    recs.shrink_to_fit();
    Some(recs)
}

/// 扫 `~/.claude/projects/*/*.jsonl`，产出用量报告。
pub(crate) fn build_report() -> Result<UsageReport, String> {
    let root = super::projects_dir().ok_or("无法定位 ~/.claude/projects 目录")?;
    build_report_in(&root)
}

fn build_report_in(root: &Path) -> Result<UsageReport, String> {
    if !root.exists() {
        return Ok(empty_report());
    }

    // 汇总全程持锁：会话页和用量页同时来拉时排队，后到的直接吃缓存，不会重复解析。
    let mut cache = file_cache().lock().unwrap_or_else(|e| e.into_inner());
    let mut present: HashSet<PathBuf> = HashSet::new();

    // 全局去重集合：key = message.id + requestId 指纹，两者都在才去重；缺任一不去重。
    let mut seen: HashSet<[u64; 2]> = HashSet::new();

    // 会话级与模型级累加器
    let mut sessions: HashMap<String, SessionAcc> = HashMap::new();
    let mut models: HashMap<Arc<str>, (Agg, bool)> = HashMap::new();
    let mut daily: HashMap<Arc<str>, DayAcc> = HashMap::new();
    let mut unpriced: HashSet<Arc<str>> = HashSet::new();
    let mut scanned_files = 0usize;

    let project_dirs =
        std::fs::read_dir(root).map_err(|e| format!("读取 projects 目录失败: {e}"))?;
    for pd in project_dirs.flatten() {
        let pdir = pd.path();
        if !pdir.is_dir() {
            continue;
        }
        let project = pdir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        let files = match std::fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for fe in files.flatten() {
            let fpath = fe.path();
            if fpath.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            scanned_files += 1;
            let session_id: Arc<str> = fpath
                .file_stem()
                .map(|s| Arc::from(s.to_string_lossy().as_ref()))
                .unwrap_or_else(|| Arc::from(""));

            let acc = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| SessionAcc::new(session_id.to_string(), project.clone()));

            // 先取大小 / 修改时间再读内容：读的过程中文件若又变长，下次比对不符会重读，不会漏。
            let meta = fe.metadata().ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta.as_ref().and_then(|m| m.modified().ok());
            present.insert(fpath.clone());
            let fresh = matches!(cache.get(&fpath), Some(c) if c.size == size && c.mtime == mtime);
            if !fresh {
                match parse_file(&fpath) {
                    Some(recs) => {
                        cache.insert(fpath.clone(), FileCache { size, mtime, recs });
                    }
                    None => {
                        cache.remove(&fpath);
                        continue;
                    }
                }
            }
            let Some(fc) = cache.get(&fpath) else { continue };

            // 本文件计入记录的最早 / 最晚时间戳，文件末尾再并进会话（省掉逐条分配字符串）
            let mut file_first: Option<&str> = None;
            let mut file_last: Option<&str> = None;

            for r in &fc.recs {
                // 去重：仅当 message.id 与 requestId 都在时
                if let Some(k) = r.dedup {
                    if !seen.insert(k) {
                        continue; // 已计过
                    }
                }
                let tok = &r.tokens;
                if tok.total() == 0 {
                    continue; // 无实际用量
                }
                let model = &r.model;
                if !r.priced {
                    unpriced.insert(model.clone());
                }

                // 会话累加
                acc.agg.tokens.add(tok);
                acc.agg.cost += r.cost;
                acc.agg.message_count += 1;
                if !r.priced {
                    acc.has_unpriced = true;
                }
                if !acc.models.contains(model) {
                    acc.models.push(model.clone());
                }
                if acc.cwd.is_none() {
                    if let Some(c) = &r.cwd {
                        acc.cwd = Some(c.to_string());
                    }
                }

                // 日桶累加（本地时区日期）；无可解析时间戳的条目不计入日 / 周 / 月速览，
                // 但仍计入会话 / 模型 / 总计。
                if let Some(day) = &r.day {
                    let d = daily.entry(day.clone()).or_default();
                    d.tokens.add(tok);
                    d.cost += r.cost;
                    d.message_count += 1;
                    if !d.models.contains(model) {
                        d.models.push(model.clone());
                    }
                    // 当日按模型 / 按会话拆分（周期速览展开详情用）
                    let bm = d.by_model.entry(model.clone()).or_default();
                    bm.tokens.add(tok);
                    bm.cost += r.cost;
                    bm.message_count += 1;
                    let bs = d.by_session.entry(session_id.clone()).or_default();
                    bs.tokens.add(tok);
                    bs.cost += r.cost;
                    bs.message_count += 1;
                }

                if let Some(ts) = r.ts.as_deref() {
                    if file_first.is_none_or(|f| ts < f) {
                        file_first = Some(ts);
                    }
                    if file_last.is_none_or(|l| ts > l) {
                        file_last = Some(ts);
                    }
                }

                // 模型累加
                let e = models
                    .entry(model.clone())
                    .or_insert_with(|| (Agg::default(), r.priced));
                e.0.tokens.add(tok);
                e.0.cost += r.cost;
                e.0.message_count += 1;
            }

            if let Some(ts) = file_first {
                if acc.first_ts.as_deref().is_none_or(|f| ts < f) {
                    acc.first_ts = Some(ts.to_string());
                }
            }
            if let Some(ts) = file_last {
                if acc.last_ts.as_deref().is_none_or(|l| ts > l) {
                    acc.last_ts = Some(ts.to_string());
                }
            }
        }
    }

    // 已删除的会话文件移出缓存
    cache.retain(|p, _| present.contains(p));
    drop(cache);

    // 组装会话列表（按 cost 高→低）
    let mut sess_out: Vec<SessionUsage> = sessions
        .into_values()
        .filter(|a| a.agg.tokens.total() > 0)
        .map(|a| a.into_view())
        .collect();
    sess_out.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    // 模型列表（按 cost 高→低）
    let mut model_out: Vec<ModelUsage> = models
        .into_iter()
        .map(|(model, (agg, priced))| ModelUsage {
            model: model.to_string(),
            input: agg.tokens.input,
            output: agg.tokens.output,
            cache_read: agg.tokens.cache_read,
            cache_write_5m: agg.tokens.cache_write_5m,
            cache_write_1h: agg.tokens.cache_write_1h,
            total_tokens: agg.tokens.total(),
            cost: agg.cost,
            priced,
        })
        .collect();
    model_out.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    // 总计
    let mut total = Tokens::default();
    let mut total_cost = 0.0;
    for s in &sess_out {
        total.input += s.input;
        total.output += s.output;
        total.cache_read += s.cache_read;
        total.cache_write_5m += s.cache_write_5m;
        total.cache_write_1h += s.cache_write_1h;
        total_cost += s.cost;
    }

    // 日桶（按日期升序，前端再聚合周 / 月）
    let slices = |m: HashMap<Arc<str>, Agg>| -> Vec<DaySlice> {
        let mut v: Vec<DaySlice> = m
            .into_iter()
            .map(|(key, a)| DaySlice {
                key: key.to_string(),
                total_tokens: a.tokens.total(),
                cost: a.cost,
                message_count: a.message_count,
            })
            .collect();
        v.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
        v
    };
    let mut daily_out: Vec<DayUsage> = daily
        .into_iter()
        .map(|(date, d)| DayUsage {
            date: date.to_string(),
            input: d.tokens.input,
            output: d.tokens.output,
            cache_read: d.tokens.cache_read,
            cache_write_5m: d.tokens.cache_write_5m,
            cache_write_1h: d.tokens.cache_write_1h,
            total_tokens: d.tokens.total(),
            cost: d.cost,
            message_count: d.message_count,
            models: d.models.iter().map(|m| m.to_string()).collect(),
            by_model: slices(d.by_model),
            by_session: slices(d.by_session),
        })
        .collect();
    daily_out.sort_by(|a, b| a.date.cmp(&b.date));

    let mut unpriced_models: Vec<String> = unpriced.iter().map(|m| m.to_string()).collect();
    unpriced_models.sort();

    Ok(UsageReport {
        sessions: sess_out.clone(),
        by_model: model_out,
        daily: daily_out,
        total_input: total.input,
        total_output: total.output,
        total_cache_read: total.cache_read,
        total_cache_write_5m: total.cache_write_5m,
        total_cache_write_1h: total.cache_write_1h,
        total_tokens: total.total(),
        total_cost,
        session_count: sess_out.len(),
        scanned_files,
        unpriced_models,
    })
}

fn empty_report() -> UsageReport {
    UsageReport {
        sessions: vec![],
        by_model: vec![],
        daily: vec![],
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_write_5m: 0,
        total_cache_write_1h: 0,
        total_tokens: 0,
        total_cost: 0.0,
        session_count: 0,
        scanned_files: 0,
        unpriced_models: vec![],
    }
}

/// 会话级累加器（内部用）。
struct SessionAcc {
    session_id: String,
    project: String,
    cwd: Option<String>,
    models: Vec<Arc<str>>,
    agg: Agg,
    has_unpriced: bool,
    first_ts: Option<String>,
    last_ts: Option<String>,
}

impl SessionAcc {
    fn new(session_id: String, project: String) -> Self {
        Self {
            session_id,
            project,
            cwd: None,
            models: Vec::new(),
            agg: Agg::default(),
            has_unpriced: false,
            first_ts: None,
            last_ts: None,
        }
    }

    fn into_view(self) -> SessionUsage {
        // 友好名：优先用 cwd 末段（最准），否则从编码目录反推
        let project_label = self
            .cwd
            .as_deref()
            .and_then(super::project_from_cwd)
            .unwrap_or_else(|| super::decode_project_label(&self.project));
        SessionUsage {
            session_id: self.session_id,
            project: self.project,
            project_label,
            cwd: self.cwd,
            models: self.models.iter().map(|m| m.to_string()).collect(),
            input: self.agg.tokens.input,
            output: self.agg.tokens.output,
            cache_read: self.agg.tokens.cache_read,
            cache_write_5m: self.agg.tokens.cache_write_5m,
            cache_write_1h: self.agg.tokens.cache_write_1h,
            total_tokens: self.agg.tokens.total(),
            cost: self.agg.cost,
            message_count: self.agg.message_count,
            first_ts: self.first_ts,
            last_ts: self.last_ts,
            has_unpriced: self.has_unpriced,
        }
    }
}

// SessionUsage 需要 Clone 以便 total 汇总后仍能 move 进报告
impl Clone for SessionUsage {
    fn clone(&self) -> Self {
        SessionUsage {
            session_id: self.session_id.clone(),
            project: self.project.clone(),
            project_label: self.project_label.clone(),
            cwd: self.cwd.clone(),
            models: self.models.clone(),
            input: self.input,
            output: self.output,
            cache_read: self.cache_read,
            cache_write_5m: self.cache_write_5m,
            cache_write_1h: self.cache_write_1h,
            total_tokens: self.total_tokens,
            cost: self.cost,
            message_count: self.message_count,
            first_ts: self.first_ts.clone(),
            last_ts: self.last_ts.clone(),
            has_unpriced: self.has_unpriced,
        }
    }
}

#[tauri::command]
pub(crate) async fn list_token_usage() -> Result<UsageReport, String> {
    super::off_main(build_report).await
}

/// 会话监控页用的精简单会话成本（按 session_id 索引）。
/// 与完整用量报告同源（build_report 全量解析），但只回必要字段，前端按 session_id 合并到会话行。
#[derive(Debug, Serialize)]
pub(crate) struct SessionCost {
    session_id: String,
    cost: f64,
    message_count: u64,
    total_tokens: u64,
    /// 含无法定价的模型 → 成本被低估（前端可加提示）
    has_unpriced: bool,
}

#[tauri::command]
pub(crate) async fn list_session_costs() -> Result<Vec<SessionCost>, String> {
    super::off_main(session_costs).await
}

fn session_costs() -> Result<Vec<SessionCost>, String> {
    let report = build_report()?;
    Ok(report
        .sessions
        .into_iter()
        .map(|s| SessionCost {
            session_id: s.session_id,
            cost: s.cost,
            message_count: s.message_count,
            total_tokens: s.total_tokens,
            has_unpriced: s.has_unpriced,
        })
        .collect())
}

/// 费率表一行（每百万 token 美元价，供前端只读展示）。
#[derive(Debug, Serialize)]
pub(crate) struct RateRow {
    name: String,   // 模型族显示名
    covers: String, // 涵盖的模型 id 示例
    input: f64,     // $/1M token（以下同）
    output: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
}

/// 各模型族费率（只读）。用代表性 id 探测 `find_pricing`，与实际计费**同一真相源**
/// （改了计费此处自动跟随，不会漂）；数值 ×1e6 转成「每百万 token 美元」。
#[tauri::command]
pub(crate) fn list_pricing() -> Vec<RateRow> {
    // (显示名, 涵盖示例, 代表性探测 id)
    let table = [
        ("Claude Fable 5.1 / Mythos 5.1", "claude-fable-5-1、claude-mythos-5-1", "claude-fable-5-1"),
        ("Claude Fable 5 / Mythos 5", "claude-fable-5、claude-mythos-5", "claude-fable-5"),
        ("Claude Opus 5.5", "claude-opus-5-5", "claude-opus-5-5"),
        ("Claude Opus 5 / 4.5–4.8", "claude-opus-5、claude-opus-4-5 … 4-8", "claude-opus-5"),
        ("Claude Opus 4.0/4.1 / Opus 3", "claude-opus-4-0、4-1、claude-3-opus", "claude-opus-4-0"),
        ("Claude Sonnet 5.5 / 5", "claude-sonnet-5-5、claude-sonnet-5", "claude-sonnet-5-5"),
        ("Claude Sonnet 4.x / 3.x", "claude-sonnet-4-6、4-5、claude-3-5-sonnet", "claude-sonnet-4-6"),
        ("Claude Haiku 4.5", "claude-haiku-4-5", "claude-haiku-4-5"),
        ("Claude Haiku 3.5", "claude-3-5-haiku", "claude-3-5-haiku"),
        ("Claude Haiku 3", "claude-3-haiku", "claude-3-haiku"),
    ];
    table
        .iter()
        .filter_map(|(name, covers, probe)| {
            find_pricing(probe).map(|p| RateRow {
                name: name.to_string(),
                covers: covers.to_string(),
                input: p.input * 1e6,
                output: p.output * 1e6,
                cache_write_5m: p.cache_write_5m * 1e6,
                cache_write_1h: p.cache_write_1h * 1e6,
                cache_read: p.cache_read * 1e6,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    /// 解析缓存 + 跨文件去重：resume 复制到新文件的同一条消息只计一次；
    /// 文件变长后重读；删掉的文件不再计入。
    #[test]
    fn report_cache_dedup_and_refresh() {
        let root = std::env::temp_dir()
            .join(format!("claudedeck-usage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proj = root.join("C--proj");
        std::fs::create_dir_all(&proj).unwrap();
        let line = |mid: &str, out: u64| {
            format!(
                r#"{{"requestId":"req_{mid}","timestamp":"2026-10-01T08:00:00.000Z","message":{{"id":"{mid}","model":"claude-opus-5-5","usage":{{"input_tokens":0,"output_tokens":{out}}}}}}}"#
            )
        };
        let a = proj.join("a.jsonl");
        let b = proj.join("b.jsonl");
        std::fs::write(&a, format!("{}\n{}\n", line("m1", 100), line("m2", 200))).unwrap();
        // b 是从 a resume 出来的：开头复制了 m1
        std::fs::write(&b, format!("{}\n{}\n", line("m1", 100), line("m3", 400))).unwrap();

        let r = build_report_in(&root).unwrap();
        assert_eq!(r.total_tokens, 700, "m1 只应计一次");
        assert_eq!(r.sessions.iter().map(|s| s.message_count).sum::<u64>(), 3);
        // 第二次走缓存，结果不变
        assert_eq!(build_report_in(&root).unwrap().total_tokens, 700);

        // a 追加一条（正在跑的会话）→ 重读
        let mut f = std::fs::OpenOptions::new().append(true).open(&a).unwrap();
        use std::io::Write;
        writeln!(f, "{}", line("m4", 50)).unwrap();
        drop(f);
        assert_eq!(build_report_in(&root).unwrap().total_tokens, 750);

        // 删掉 b → m3 消失，m1 仍由 a 计入
        std::fs::remove_file(&b).unwrap();
        let r = build_report_in(&root).unwrap();
        assert_eq!(r.total_tokens, 350);
        assert_eq!(r.session_count, 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pricing_opus_new_models() {
        // opus 4.5/4.6/4.7/4.8 都应是 $5/$25
        for m in [
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-opus-4-5",
            "claude-opus-4.8-20260528",
            "anthropic/claude-opus-4.8",
        ] {
            let p = find_pricing(m).unwrap_or_else(|| panic!("无费率: {m}"));
            assert!(approx(p.input, 5e-6), "{m} input");
            assert!(approx(p.output, 25e-6), "{m} output");
            assert!(approx(p.cache_read, 0.5e-6), "{m} read");
            assert!(approx(p.cache_write_5m, 6.25e-6), "{m} 5m");
            assert!(approx(p.cache_write_1h, 10e-6), "{m} 1h");
        }
    }

    #[test]
    fn pricing_opus_old_is_15_75() {
        for m in ["claude-opus-4-0", "claude-opus-4-1", "claude-opus-4", "claude-3-opus"] {
            let p = find_pricing(m).unwrap();
            assert!(approx(p.input, 15e-6), "{m}");
            assert!(approx(p.output, 75e-6), "{m}");
            assert!(approx(p.cache_write_1h, 30e-6), "{m}");
        }
    }

    #[test]
    fn pricing_sonnet_and_haiku() {
        let s = find_pricing("claude-sonnet-4-6").unwrap();
        assert!(approx(s.input, 3e-6) && approx(s.output, 15e-6));
        assert!(approx(s.cache_write_5m, 3.75e-6) && approx(s.cache_write_1h, 6e-6));
        let h = find_pricing("claude-haiku-4-5").unwrap();
        assert!(approx(h.input, 1e-6) && approx(h.output, 5e-6));
        assert!(approx(h.cache_write_1h, 2e-6));
    }

    #[test]
    fn pricing_fable5_and_sonnet5() {
        // Fable 5 / Mythos 5 = $10/$50，缓存派生 1 / 12.5 / 20
        for m in ["claude-fable-5", "claude-mythos-5", "anthropic/claude-fable-5"] {
            let p = find_pricing(m).unwrap_or_else(|| panic!("无费率: {m}"));
            assert!(approx(p.input, 10e-6), "{m} input");
            assert!(approx(p.output, 50e-6), "{m} output");
            assert!(approx(p.cache_read, 1e-6), "{m} read");
            assert!(approx(p.cache_write_5m, 12.5e-6), "{m} 5m");
            assert!(approx(p.cache_write_1h, 20e-6), "{m} 1h");
        }
        // Sonnet 5 / 5.5 = $2/$10，缓存 0.2 / 2.5 / 4；4.x 不受影响
        for m in ["claude-sonnet-5", "claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"] {
            let s = find_pricing(m).unwrap_or_else(|| panic!("无费率: {m}"));
            assert!(approx(s.input, 2e-6) && approx(s.output, 10e-6), "{m}");
            assert!(approx(s.cache_read, 0.2e-6), "{m} read");
            assert!(approx(s.cache_write_5m, 2.5e-6) && approx(s.cache_write_1h, 4e-6), "{m}");
        }
        for m in ["claude-sonnet-4-5-20250929", "claude-3-5-sonnet"] {
            let s = find_pricing(m).unwrap();
            assert!(approx(s.input, 3e-6), "{m}");
        }
    }

    #[test]
    fn pricing_opus5_family_and_fable51() {
        // Opus 5 = $5/$25（同 4.5–4.8）
        let p = find_pricing("claude-opus-5").unwrap();
        assert!(approx(p.input, 5e-6) && approx(p.output, 25e-6));
        assert!(approx(p.cache_read, 0.5e-6));
        // Opus 5.5 = $4/$20，缓存读 0.05× = $0.20
        for m in ["claude-opus-5-5", "anthropic/claude-opus-5.5"] {
            let p = find_pricing(m).unwrap_or_else(|| panic!("无费率: {m}"));
            assert!(approx(p.input, 4e-6) && approx(p.output, 20e-6), "{m}");
            assert!(approx(p.cache_read, 0.2e-6), "{m} read");
            assert!(approx(p.cache_write_5m, 5e-6) && approx(p.cache_write_1h, 8e-6), "{m}");
        }
        // Fable / Mythos 5.1 = $10/$50，缓存读 0.025× = $0.25
        for m in ["claude-fable-5-1", "claude-mythos-5-1"] {
            let p = find_pricing(m).unwrap_or_else(|| panic!("无费率: {m}"));
            assert!(approx(p.input, 10e-6) && approx(p.output, 50e-6), "{m}");
            assert!(approx(p.cache_read, 0.25e-6), "{m} read");
            assert!(approx(p.cache_write_5m, 12.5e-6) && approx(p.cache_write_1h, 20e-6), "{m}");
        }
    }

    #[test]
    fn synthetic_and_unknown_have_no_price() {
        assert!(find_pricing("<synthetic>").is_none());
        assert!(find_pricing("gpt-4o").is_none());
    }

    #[test]
    fn cost_formula_splits_1h_and_5m() {
        // 1000 in / 500 out / 2000 read / 4000 5m / 8000 1h，opus 新价
        let t = Tokens {
            input: 1000,
            output: 500,
            cache_read: 2000,
            cache_write_5m: 4000,
            cache_write_1h: 8000,
        };
        let got = t.cost("claude-opus-4-8").unwrap();
        let want = 1000.0 * 5e-6
            + 500.0 * 25e-6
            + 2000.0 * 0.5e-6
            + 4000.0 * 6.25e-6
            + 8000.0 * 10e-6;
        assert!(approx(got, want), "got {got} want {want}");
        // 1h(10e-6) 必须比按 5m(6.25e-6) 贵：验证「拆分更准」确有差异
        let as_if_all_5m = (4000.0 + 8000.0) * 6.25e-6;
        let real_cache_write = 4000.0 * 6.25e-6 + 8000.0 * 10e-6;
        assert!(real_cache_write > as_if_all_5m);
    }

    #[test]
    fn split_cache_falls_back_to_5m_for_old_format() {
        // 无 cache_creation 明细，只有总数 → 全算 5m
        let u = RawUsage {
            cache_creation_input_tokens: Some(9999),
            cache_creation: None,
            ..Default::default()
        };
        assert_eq!(split_cache(&u), (9999, 0));
        // 有明细 → 按明细拆
        let u2 = RawUsage {
            cache_creation_input_tokens: Some(100),
            cache_creation: Some(RawCacheCreation {
                ephemeral_5m_input_tokens: Some(30),
                ephemeral_1h_input_tokens: Some(70),
            }),
            ..Default::default()
        };
        assert_eq!(split_cache(&u2), (30, 70));
    }

    #[test]
    fn local_date_parses_iso_and_rejects_garbage() {
        // 有效 ISO（带毫秒 + Z）→ 返回 YYYY-MM-DD（具体值依机器时区，故只校验格式）
        let d = local_date("2026-06-07T08:13:00.123Z").expect("应解析成功");
        assert_eq!(d.len(), 10, "日期串应为 YYYY-MM-DD");
        assert_eq!(d.matches('-').count(), 2);
        // 带时区偏移也应解析
        assert!(local_date("2026-06-07T08:13:00+08:00").is_some());
        // 垃圾串 → None
        assert!(local_date("not-a-timestamp").is_none());
        assert!(local_date("").is_none());
    }

    #[test]
    fn normalize_strips_provider_and_dots() {
        assert_eq!(normalize_model("anthropic/claude-opus-4.8"), "claude-opus-4-8");
        assert_eq!(
            normalize_model("openrouter/anthropic/claude-opus-4.7"),
            "claude-opus-4-7"
        );
        assert_eq!(normalize_model("anthropic.claude-sonnet-4-6"), "claude-sonnet-4-6");
    }
}
