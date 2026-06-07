import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// 与后端 usage.rs 的 Serialize 结构对应
type SessionUsage = {
  session_id: string;
  project: string;
  project_label: string;
  cwd: string | null;
  models: string[];
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  total_tokens: number;
  cost: number;
  message_count: number;
  first_ts: string | null;
  last_ts: string | null;
  has_unpriced: boolean;
};

type ModelUsage = {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  total_tokens: number;
  cost: number;
  priced: boolean;
};

type DayUsage = {
  date: string; // YYYY-MM-DD（本地时区）
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  total_tokens: number;
  cost: number;
  message_count: number;
  models: string[];
};

type UsageReport = {
  sessions: SessionUsage[];
  by_model: ModelUsage[];
  daily: DayUsage[];
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write_5m: number;
  total_cache_write_1h: number;
  total_tokens: number;
  total_cost: number;
  session_count: number;
  scanned_files: number;
  unpriced_models: string[];
};

/** token 数：>=1M → 1.23M，>=1K → 12.3K，否则原值。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/** 费用：>=1 两位小数，<1 四位小数（小额也看得清）。 */
function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** 模型名简写：去 claude- 前缀，opus-4-8 这种留核心。 */
function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}

function fmtDate(ts: string | null): string {
  if (!ts) return "";
  // ISO 字符串，取到分钟
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.slice(0, 16).replace("T", " ");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

type Period = "day" | "week" | "month";

type PeriodRow = {
  key: string;
  label: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  total_tokens: number;
  cost: number;
  message_count: number;
  models: string[];
};

const SESSION_PAGE_SIZE = 12;
const PERIOD_PAGE_SIZE = 10;

/** 简单分页控件：‹ 上一页 · 第 x/y 页 · 下一页 ›。仅 1 页时不渲染。 */
function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="usage-pager">
      <button
        className="usage-pager-btn"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
      >
        ‹ 上一页
      </button>
      <span className="usage-pager-info">
        第 {page + 1}/{pageCount} 页 · 共 {total} 条
      </span>
      <button
        className="usage-pager-btn"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        下一页 ›
      </button>
    </div>
  );
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 取某日所在周的周一（YYYY-MM-DD，本地时区，周一为周首）。 */
function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  return ymd(d);
}

/** 把后端日桶按 日/周/月 再聚合，返回按时间倒序的周期行。 */
function groupByPeriod(daily: DayUsage[], mode: Period): PeriodRow[] {
  const map = new Map<string, PeriodRow>();
  for (const d of daily) {
    let key: string;
    let label: string;
    if (mode === "day") {
      key = d.date;
      label = d.date;
    } else if (mode === "week") {
      key = mondayOf(d.date);
      const sun = new Date(key + "T00:00:00");
      sun.setDate(sun.getDate() + 6);
      label = `${key} ~ ${ymd(sun).slice(5)}`;
    } else {
      key = d.date.slice(0, 7); // YYYY-MM
      const [y, m] = key.split("-");
      label = `${y}年${Number(m)}月`;
    }
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        label,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write_5m: 0,
        cache_write_1h: 0,
        total_tokens: 0,
        cost: 0,
        message_count: 0,
        models: [],
      };
      map.set(key, row);
    }
    row.input += d.input;
    row.output += d.output;
    row.cache_read += d.cache_read;
    row.cache_write_5m += d.cache_write_5m;
    row.cache_write_1h += d.cache_write_1h;
    row.total_tokens += d.total_tokens;
    row.cost += d.cost;
    row.message_count += d.message_count;
    for (const m of d.models) if (!row.models.includes(m)) row.models.push(m);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

export default function UsageView() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<Period>("day");
  const [sessionPage, setSessionPage] = useState(0);
  const [periodPage, setPeriodPage] = useState(0);

  async function reload() {
    setLoading(true);
    try {
      setReport(await invoke<UsageReport>("list_token_usage"));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    reload();
  }, []);

  const maxModelCost = useMemo(
    () => (report ? Math.max(1e-9, ...report.by_model.map((m) => m.cost)) : 1),
    [report],
  );

  const periodRows = useMemo(
    () => (report ? groupByPeriod(report.daily, period) : []),
    [report, period],
  );
  const maxPeriodCost = useMemo(
    () => Math.max(1e-9, ...periodRows.map((p) => p.cost)),
    [periodRows],
  );

  // 切日/周/月时回到第 1 页
  useEffect(() => setPeriodPage(0), [period]);
  // 数据重扫后两张表都回到第 1 页
  useEffect(() => {
    setPeriodPage(0);
    setSessionPage(0);
  }, [report]);

  const periodPageCount = Math.max(1, Math.ceil(periodRows.length / PERIOD_PAGE_SIZE));
  const periodSlice = useMemo(
    () =>
      periodRows.slice(
        periodPage * PERIOD_PAGE_SIZE,
        periodPage * PERIOD_PAGE_SIZE + PERIOD_PAGE_SIZE,
      ),
    [periodRows, periodPage],
  );

  const sessions = report?.sessions ?? [];
  const sessionPageCount = Math.max(1, Math.ceil(sessions.length / SESSION_PAGE_SIZE));
  const sessionSlice = useMemo(
    () =>
      sessions.slice(
        sessionPage * SESSION_PAGE_SIZE,
        sessionPage * SESSION_PAGE_SIZE + SESSION_PAGE_SIZE,
      ),
    [sessions, sessionPage],
  );

  if (err) {
    return (
      <div className="usage-view">
        <div className="banner err">读取用量失败：{err}</div>
      </div>
    );
  }

  if (loading && !report) {
    return (
      <div className="usage-view">
        <div className="empty">
          <p>正在扫描 token 用量…</p>
          <span>遍历 ~/.claude/projects 下所有会话记录，首次稍候</span>
        </div>
      </div>
    );
  }

  if (!report || report.sessions.length === 0) {
    return (
      <div className="usage-view">
        <div className="empty">
          <p>暂无 token 用量数据</p>
          <span>运行过 Claude Code 会话后，这里会统计每个会话的消耗与费用</span>
        </div>
      </div>
    );
  }

  const r = report;

  return (
    <div className="usage-view">
      <div className="usage-toolbar">
        <div className="usage-title">用量计费</div>
        <span className="usage-sub">
          {r.session_count} 个会话 · 扫描 {r.scanned_files} 个记录文件
        </span>
        <button className="refresh" onClick={reload} title="重新扫描">
          ↻
        </button>
      </div>

      {/* 总计卡片 */}
      <div className="usage-stats">
        <div className="usage-stat primary">
          <div className="usage-stat-label">总费用（估算）</div>
          <div className="usage-stat-val">{fmtCost(r.total_cost)}</div>
        </div>
        <div className="usage-stat">
          <div className="usage-stat-label">总 Token</div>
          <div className="usage-stat-val">{fmtTokens(r.total_tokens)}</div>
        </div>
        <div className="usage-stat">
          <div className="usage-stat-label">输入 / 输出</div>
          <div className="usage-stat-val sm">
            {fmtTokens(r.total_input)} / {fmtTokens(r.total_output)}
          </div>
        </div>
        <div className="usage-stat">
          <div className="usage-stat-label">缓存 读 / 写5m / 写1h</div>
          <div className="usage-stat-val sm">
            {fmtTokens(r.total_cache_read)} / {fmtTokens(r.total_cache_write_5m)} /{" "}
            {fmtTokens(r.total_cache_write_1h)}
          </div>
        </div>
      </div>

      {/* 计价口径说明 */}
      <div className="usage-note">
        费用按 Anthropic 公开 API 价格估算（硬编码费率表）。缓存写入 <b>1h 按 2×、5m 按
        1.25×</b> 分别计价，比 ccusage（缓存统一按 1.25×）更贴近真实；故 1h
        缓存较多的会话此处会略高于 ccusage。订阅用户实际不按量计费，此为等效 API 成本参考。
        {r.unpriced_models.length > 0 && (
          <span className="usage-warn">
            {" "}
            ⚠ 无费率模型（成本未计入）：{r.unpriced_models.join("、")}
          </span>
        )}
      </div>

      {/* 日 / 周 / 月 速览 */}
      <div className="usage-period">
        <div className="usage-period-head">
          <span className="usage-period-title">周期速览</span>
          <div className="usage-seg">
            {(["day", "week", "month"] as Period[]).map((p) => (
              <button
                key={p}
                className={`usage-seg-btn ${period === p ? "active" : ""}`}
                onClick={() => setPeriod(p)}
              >
                {p === "day" ? "日" : p === "week" ? "周" : "月"}
              </button>
            ))}
          </div>
          <span className="usage-period-count">{periodRows.length} 个周期</span>
        </div>
        {periodRows.length === 0 ? (
          <div className="usage-period-empty">无带时间戳的用量记录</div>
        ) : (
          <div className="table-wrap usage-period-wrap">
            <table className="sessions usage-table">
              <thead>
                <tr>
                  <th>{period === "day" ? "日期" : period === "week" ? "周（周一起）" : "月份"}</th>
                  <th className="num">输入</th>
                  <th className="num">输出</th>
                  <th className="num">缓存</th>
                  <th className="num">总 Token</th>
                  <th className="num">消息</th>
                  <th>费用</th>
                </tr>
              </thead>
              <tbody>
                {periodSlice.map((p) => (
                  <tr key={p.key}>
                    <td className="usage-period-label">{p.label}</td>
                    <td className="num mono">{fmtTokens(p.input)}</td>
                    <td className="num mono">{fmtTokens(p.output)}</td>
                    <td className="num mono">
                      {fmtTokens(p.cache_read + p.cache_write_5m + p.cache_write_1h)}
                    </td>
                    <td className="num mono">{fmtTokens(p.total_tokens)}</td>
                    <td className="num mono dim">{p.message_count}</td>
                    <td className="usage-period-cost-cell">
                      <div className="usage-period-bar">
                        <div
                          className="usage-period-bar-fill"
                          style={{ width: `${(p.cost / maxPeriodCost) * 100}%` }}
                        />
                      </div>
                      <span className="usage-cost mono">{fmtCost(p.cost)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager
          page={periodPage}
          pageCount={periodPageCount}
          total={periodRows.length}
          onPage={setPeriodPage}
        />
      </div>

      {/* 按模型分组 */}
      {r.by_model.length > 0 && (
        <div className="usage-models">
          {r.by_model.map((m) => (
            <div className="usage-model-row" key={m.model}>
              <span className="usage-model-name mono" title={m.model}>
                {shortModel(m.model)}
                {!m.priced && <span className="usage-model-unpriced">无费率</span>}
              </span>
              <div className="usage-model-bar">
                <div
                  className="usage-model-bar-fill"
                  style={{ width: `${(m.cost / maxModelCost) * 100}%` }}
                />
              </div>
              <span className="usage-model-tok">{fmtTokens(m.total_tokens)}</span>
              <span className="usage-model-cost">{fmtCost(m.cost)}</span>
            </div>
          ))}
        </div>
      )}

      {/* 会话明细表（按费用高→低） */}
      <div className="table-wrap usage-table-wrap">
        <table className="sessions usage-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>模型</th>
              <th className="num">输入</th>
              <th className="num">输出</th>
              <th className="num">缓存读</th>
              <th className="num">写5m</th>
              <th className="num">写1h</th>
              <th className="num">总 Token</th>
              <th className="num">费用</th>
            </tr>
          </thead>
          <tbody>
            {sessionSlice.map((s) => (
              <tr key={s.session_id} title={`会话 ${s.session_id}\n${fmtDate(s.last_ts)}`}>
                <td>
                  <div className="usage-proj">{s.project_label || s.project}</div>
                  <div className="usage-proj-sub mono">
                    {s.message_count} 条 · {fmtDate(s.last_ts)}
                  </div>
                </td>
                <td className="usage-models-cell mono">
                  {s.models.map((m) => shortModel(m)).join(", ")}
                  {s.has_unpriced && <span className="usage-model-unpriced">部分无费率</span>}
                </td>
                <td className="num mono">{fmtTokens(s.input)}</td>
                <td className="num mono">{fmtTokens(s.output)}</td>
                <td className="num mono">{fmtTokens(s.cache_read)}</td>
                <td className="num mono">{fmtTokens(s.cache_write_5m)}</td>
                <td className="num mono">{fmtTokens(s.cache_write_1h)}</td>
                <td className="num mono">{fmtTokens(s.total_tokens)}</td>
                <td className="num mono usage-cost">{fmtCost(s.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="usage-total-row">
              <td>合计</td>
              <td className="dim">{r.by_model.length} 个模型</td>
              <td className="num mono">{fmtTokens(r.total_input)}</td>
              <td className="num mono">{fmtTokens(r.total_output)}</td>
              <td className="num mono">{fmtTokens(r.total_cache_read)}</td>
              <td className="num mono">{fmtTokens(r.total_cache_write_5m)}</td>
              <td className="num mono">{fmtTokens(r.total_cache_write_1h)}</td>
              <td className="num mono">{fmtTokens(r.total_tokens)}</td>
              <td className="num mono usage-cost">{fmtCost(r.total_cost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager
        page={sessionPage}
        pageCount={sessionPageCount}
        total={sessions.length}
        onPage={setSessionPage}
      />
    </div>
  );
}
