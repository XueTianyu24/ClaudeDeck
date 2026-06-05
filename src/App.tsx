import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Session = {
  pid: number | null;
  session_id: string | null;
  cwd: string | null;
  project: string | null;
  status: string | null;
  version: string | null;
  kind: string | null;
  entrypoint: string | null;
  started_at: number | null;
  updated_at: number | null;
  running_ms: number | null;
  idle_ms: number | null;
  alive: boolean;
  stuck: boolean;
  parse_error: string | null;
  file: string;
};

const POLL_MS = 3000;

function fmtDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function fmtIdle(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  return `${fmtDuration(ms)}前`;
}

type State = "stuck" | "busy" | "idle" | "dead" | "error" | "unknown";

function sessionState(s: Session): State {
  if (s.parse_error) return "error";
  if (!s.alive) return "dead";
  if (s.stuck) return "stuck";
  if (s.status === "busy") return "busy";
  if (s.status === "idle") return "idle";
  return "unknown";
}

const STATE_LABEL: Record<State, string> = {
  stuck: "疑似卡死",
  busy: "运行中",
  idle: "空闲",
  dead: "进程已退",
  error: "解析失败",
  unknown: "未知",
};

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);

  async function refresh() {
    try {
      const data = await invoke<Session[]>("list_sessions");
      setSessions(data);
      setError(null);
      setLastSync(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const liveCount = sessions.filter((s) => s.alive && !s.parse_error).length;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◧</span>
          <div>
            <h1>ClaudeDeck</h1>
            <p className="subtitle">Claude Code 会话监控</p>
          </div>
        </div>
        <div className="meta">
          <span className="count">{liveCount} 个活动会话</span>
          <span className="sync">
            {lastSync ? `已同步 ${fmtIdle(Date.now() - lastSync)}` : "同步中…"}
          </span>
          <button className="refresh" onClick={refresh} title="立即刷新">
            ↻
          </button>
        </div>
      </header>

      {error && <div className="banner err">读取失败：{error}</div>}

      {sessions.length === 0 && !error ? (
        <div className="empty">
          <p>当前没有运行中的 Claude Code 会话</p>
          <span>启动一个 CC 会话后会自动出现在这里</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="sessions">
            <thead>
              <tr>
                <th>状态</th>
                <th>项目</th>
                <th>PID</th>
                <th>运行时长</th>
                <th>最后心跳</th>
                <th>版本</th>
                <th>类型</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const st = sessionState(s);
                return (
                  <tr key={s.file} className={st === "dead" || st === "error" ? "muted" : ""}>
                    <td>
                      <span className={`badge ${st}`}>
                        <i className="dot" />
                        {STATE_LABEL[st]}
                      </span>
                    </td>
                    <td>
                      <div className="proj">{s.project ?? "—"}</div>
                      <div className="cwd" title={s.cwd ?? ""}>
                        {s.parse_error ? s.parse_error : s.cwd ?? s.file}
                      </div>
                    </td>
                    <td className="mono">{s.pid ?? "—"}</td>
                    <td className="mono">{fmtDuration(s.running_ms)}</td>
                    <td className="mono">{fmtIdle(s.idle_ms)}</td>
                    <td className="mono dim">{s.version ?? "—"}</td>
                    <td className="dim">{s.kind ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export default App;
