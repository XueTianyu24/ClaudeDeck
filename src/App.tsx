import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
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

// CC 会话 status 枚举（实测自 2.1.165 二进制：Blf=["busy","shell","idle","waiting"]）
type State =
  | "stuck"
  | "busy"
  | "shell"
  | "waiting"
  | "idle"
  | "dead"
  | "error"
  | "unknown";

function sessionState(s: Session): State {
  if (s.parse_error) return "error";
  if (!s.alive) return "dead";
  if (s.stuck) return "stuck";
  if (s.status === "busy") return "busy";
  if (s.status === "shell") return "shell";
  if (s.status === "waiting") return "waiting";
  if (s.status === "idle") return "idle";
  return "unknown";
}

const STATE_LABEL: Record<State, string> = {
  stuck: "疑似卡死",
  busy: "运行中",
  shell: "执行命令",
  waiting: "等待输入",
  idle: "空闲",
  dead: "进程已退",
  error: "解析失败",
  unknown: "未知",
};

// 未知状态兜底：把 CC 写入的原始 status 文本带出来，便于发现未映射的新值
function stateLabel(st: State, s: Session): string {
  if (st === "unknown" && s.status) return `未知(${s.status})`;
  return STATE_LABEL[st];
}

type Theme = "dark" | "light";

// ── 通知设置 ──
type NotifySettings = {
  notifyDone: boolean; // 长任务完成（busy/shell → idle）
  notifyWaiting: boolean; // 等待输入（→ waiting）
  thresholdSec: number; // 完成通知的最小 busy 时长
  mute: boolean; // 静音（关声音，仍弹窗）
};

const DEFAULT_SETTINGS: NotifySettings = {
  notifyDone: true,
  notifyWaiting: true,
  thresholdSec: 30,
  mute: false,
};

function loadSettings(): NotifySettings {
  try {
    const raw = localStorage.getItem("cd-notify");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

// ── 提示音（WebAudio 合成，无需音频文件）──
let audioCtx: AudioContext | null = null;
function playDing(kind: "done" | "waiting") {
  try {
    audioCtx = audioCtx || new AudioContext();
    const ctx = audioCtx;
    const t0 = ctx.currentTime;
    const notes = kind === "done" ? [660, 990] : [990, 660];
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const start = t0 + i * 0.13;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(start);
      o.stop(start + 0.22);
    });
  } catch {
    /* 音频不可用则忽略 */
  }
}

async function ensurePermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

async function notify(title: string, body: string) {
  if (await ensurePermission()) sendNotification({ title, body });
}

type Tracked = { status: string | null; active: boolean; busySince?: number };

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("cd-theme") as Theme) || "dark"
  );
  const [settings, setSettings] = useState<NotifySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  const prevRef = useRef<Map<string, Tracked>>(new Map());
  const seededRef = useRef(false);
  const settingsRef = useRef(settings);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cd-theme", theme);
  }, [theme]);

  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem("cd-notify", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    ensurePermission();
  }, []);

  // 检测状态翻转并触发通知（用 ref 读最新设置，避免重建轮询）
  function detectTransitions(data: Session[]) {
    const cfg = settingsRef.current;
    const prev = prevRef.current;
    const next = new Map<string, Tracked>();
    const now = Date.now();

    for (const s of data) {
      const p = prev.get(s.file);
      const active = s.status === "busy" || s.status === "shell";
      // 进入活动态时记录起点；活动态内部切换（busy↔shell）保持起点不变
      const busySince = active ? (p?.active ? p.busySince : now) : undefined;
      next.set(s.file, { status: s.status, active, busySince });

      if (!seededRef.current) continue; // 首轮只做种子，不通知

      // 长任务完成：活动 → idle，且 busy 时长达阈值
      if (p?.active && s.status === "idle" && cfg.notifyDone) {
        const dur = p.busySince ? now - p.busySince : 0;
        if (dur >= cfg.thresholdSec * 1000) {
          notify(`✅ ${s.project ?? "会话"} · 任务完成`, `用时 ${fmtDuration(dur)}`);
          if (!cfg.mute) playDing("done");
        }
      }

      // 等待输入：进入 waiting（不受阈值限制，立即提醒）
      if (s.status === "waiting" && p?.status !== "waiting" && cfg.notifyWaiting) {
        notify(`⏳ ${s.project ?? "会话"} · 等待你的输入`, s.cwd ?? "");
        if (!cfg.mute) playDing("waiting");
      }
    }

    prevRef.current = next;
    seededRef.current = true;
  }

  async function refresh() {
    try {
      const data = await invoke<Session[]>("list_sessions");
      detectTransitions(data);
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

  function testNotify() {
    notify("🔔 ClaudeDeck 测试通知", "通知和声音正常工作");
    if (!settings.mute) playDing("done");
  }

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
          <div className="settings-wrap">
            <button
              className={`refresh ${showSettings ? "active" : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              title="通知设置"
            >
              🔔
            </button>
            {showSettings && (
              <div className="settings-panel">
                <h3>通知设置</h3>
                <label className="row-opt">
                  <input
                    type="checkbox"
                    checked={settings.notifyDone}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, notifyDone: e.target.checked }))
                    }
                  />
                  长任务完成时通知
                </label>
                <label className="row-opt indent">
                  阈值
                  <input
                    type="number"
                    min={0}
                    className="num"
                    value={settings.thresholdSec}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        thresholdSec: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                  />
                  秒以上
                </label>
                <label className="row-opt">
                  <input
                    type="checkbox"
                    checked={settings.notifyWaiting}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, notifyWaiting: e.target.checked }))
                    }
                  />
                  等待输入时通知
                </label>
                <label className="row-opt">
                  <input
                    type="checkbox"
                    checked={settings.mute}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, mute: e.target.checked }))
                    }
                  />
                  静音（只弹窗不响铃）
                </label>
                <button className="test-btn" onClick={testNotify}>
                  发送测试通知
                </button>
              </div>
            )}
          </div>
          <button
            className="refresh"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "切换到浅色" : "切换到深色"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
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
                        {stateLabel(st, s)}
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
