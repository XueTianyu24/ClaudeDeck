import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import "./App.css";
import logo from "./assets/logo.png";
import MemoryView from "./MemoryView";
import SkillView from "./SkillView";
import LauncherView from "./LauncherView";

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
  dingSec: number; // 提示音持续时长（循环 ding）
  mute: boolean; // 静音（关声音，仍弹窗）
};

const DEFAULT_SETTINGS: NotifySettings = {
  notifyDone: true,
  notifyWaiting: true,
  thresholdSec: 30,
  dingSec: 2.5,
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
// 用 Web Audio 自带时钟一次性调度整段循环 ding，不依赖 setTimeout（后台会被限流）。
let audioCtx: AudioContext | null = null;
function playDing(kind: "done" | "waiting", durationSec = 2.5) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const notes = kind === "done" ? [660, 990] : [990, 660];
    const cycle = 0.5; // 每个 ding 周期 0.5s（0.4s 双音 + 0.1s 间隔）
    const total = Math.max(0.4, durationSec);
    const t0 = ctx.currentTime;
    for (let off = 0; off < total; off += cycle) {
      const base = t0 + off;
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        const start = base + i * 0.13;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(start);
        o.stop(start + 0.22);
      });
    }
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

type PhoneStatus = {
  installed: boolean;
  script_exists: boolean;
  bark_key: string | null;
  bark_enabled: boolean;
  pushplus_token: string | null;
  pushplus_enabled: boolean;
  threshold_sec: number | null;
  script_path: string;
};

type PushChannel = "bark" | "pushplus";

const PUSHPLUS_HINT =
  "微信搜公众号「pushplus 推送加」关注 → 实名(约 4 元) → 「一对一推送」复制 token。⚠️ 记得把该服务号的「消息免打扰」关掉，否则收不到！";

type EnvStatus = {
  home_found: boolean;
  claude_dir_exists: boolean;
  sessions_dir_exists: boolean;
  curl_available: boolean;
};

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("cd-theme") as Theme) || "dark"
  );
  const [settings, setSettings] = useState<NotifySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<
    "sessions" | "memory" | "skills" | "launcher"
  >("sessions");

  // 运行环境探测（区分没装 CC / 装了没跑；curl 可用性）
  const [env, setEnv] = useState<EnvStatus | null>(null);

  // 手机推送（多渠道 hook）状态
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [barkKey, setBarkKey] = useState("");
  const [barkEnabled, setBarkEnabled] = useState(true);
  const [pushplusToken, setPushplusToken] = useState("");
  const [pushplusEnabled, setPushplusEnabled] = useState(true);
  const [phoneThresh, setPhoneThresh] = useState(30);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null);

  // 给事件监听读最新设置用（监听只订阅一次，避免重订阅）
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cd-theme", theme);
  }, [theme]);

  // 后端检测到翻转时 emit "notify-ding"，前端补一段循环提示音（弹窗由后端发）。
  useEffect(() => {
    const un = listen<string>("notify-ding", (e) => {
      const cfg = settingsRef.current;
      if (cfg.mute) return;
      playDing(e.payload === "waiting" ? "waiting" : "done", cfg.dingSec);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 通知检测在 Rust 后端常驻线程里做（webview 后台会被限流/冻结 setInterval，
  // 放前端会漏发）。这里只把配置推给后端 + 持久化到 localStorage。
  useEffect(() => {
    localStorage.setItem("cd-notify", JSON.stringify(settings));
    invoke("set_notify_config", {
      cfg: {
        enabled: settings.notifyDone || settings.notifyWaiting,
        done: settings.notifyDone,
        waiting: settings.notifyWaiting,
        threshold_ms: settings.thresholdSec * 1000,
      },
    }).catch(() => {});
  }, [settings]);

  useEffect(() => {
    ensurePermission();
  }, []);

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

  function testNotify() {
    notify("🔔 ClaudeDeck 测试通知", "通知和声音正常工作");
    if (!settings.mute) playDing("done", settings.dingSec);
  }

  async function loadPhone() {
    try {
      const st = await invoke<PhoneStatus>("get_phone_hook_status");
      setPhone(st);
      if (st.bark_key) setBarkKey(st.bark_key);
      setBarkEnabled(st.bark_enabled);
      if (st.pushplus_token) setPushplusToken(st.pushplus_token);
      setPushplusEnabled(st.pushplus_enabled);
      if (st.threshold_sec != null) setPhoneThresh(st.threshold_sec);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    loadPhone();
  }, []);

  async function loadEnv() {
    try {
      setEnv(await invoke<EnvStatus>("get_env_status"));
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    loadEnv();
  }, []);

  async function installPhone() {
    setPhoneBusy(true);
    setPhoneMsg(null);
    try {
      const st = await invoke<PhoneStatus>("install_phone_hook", {
        barkKey: barkKey.trim(),
        barkEnabled,
        pushplusToken: pushplusToken.trim(),
        pushplusEnabled,
        thresholdSec: phoneThresh,
      });
      setPhone(st);
      setPhoneMsg("✅ 已安装，新开一个 Claude Code 会话即可生效");
    } catch (e) {
      setPhoneMsg("❌ " + String(e));
    } finally {
      setPhoneBusy(false);
    }
  }

  async function uninstallPhone() {
    setPhoneBusy(true);
    setPhoneMsg(null);
    try {
      const st = await invoke<PhoneStatus>("uninstall_phone_hook");
      setPhone(st);
      setPhoneMsg("已卸载");
    } catch (e) {
      setPhoneMsg("❌ " + String(e));
    } finally {
      setPhoneBusy(false);
    }
  }

  async function testPhone(ch: PushChannel) {
    const key = (ch === "bark" ? barkKey : pushplusToken).trim();
    if (!key) return;
    setPhoneBusy(true);
    setPhoneMsg(null);
    try {
      await invoke("test_phone_push", { channel: ch, key });
      setPhoneMsg(`✅ 已发往${ch === "bark" ? "Bark" : "微信"}，看手机锁屏`);
    } catch (e) {
      setPhoneMsg("❌ " + String(e));
    } finally {
      setPhoneBusy(false);
    }
  }

  const liveCount = sessions.filter((s) => s.alive && !s.parse_error).length;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src={logo} alt="ClaudeDeck" />
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
                <label className="row-opt indent">
                  提示音时长
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    className="num"
                    disabled={settings.mute}
                    value={settings.dingSec}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        dingSec: Math.max(0.5, Number(e.target.value) || 0.5),
                      }))
                    }
                  />
                  秒
                </label>
                <button className="test-btn" onClick={testNotify}>
                  发送测试通知
                </button>

                <div className="phone-section">
                  <h3>📱 手机推送</h3>
                  <p className="phone-hint">
                    任务完成 / 等待授权时推到手机，应用不用开着。两个渠道各自有「启用」开关，可同时推也可只留一个。
                    {phone?.installed ? " 状态：已安装 ✅" : " 状态：未安装"}
                  </p>
                  {env && !env.curl_available && (
                    <p className="phone-msg">
                      ⚠️ 未检测到 curl.exe，手机推送将无法工作（Win10 1803
                      以下需手动安装 curl）
                    </p>
                  )}

                  <div className="push-channel">
                    <div className="push-channel-title">
                      <span>🍎 Bark（iPhone，免费）</span>
                      <label className="ch-toggle" title="启用该渠道">
                        <input
                          type="checkbox"
                          checked={barkEnabled}
                          disabled={!barkKey.trim()}
                          onChange={(e) => setBarkEnabled(e.target.checked)}
                        />
                        启用
                      </label>
                    </div>
                    <label className="field">
                      <input
                        type="text"
                        className="keyinput"
                        placeholder="api.day.app/ 后那串，不用可留空"
                        value={barkKey}
                        onChange={(e) => setBarkKey(e.target.value)}
                      />
                    </label>
                    <div className="phone-btns">
                      <button
                        className="test-btn"
                        disabled={phoneBusy || !barkKey.trim()}
                        onClick={() => testPhone("bark")}
                      >
                        测试 Bark
                      </button>
                    </div>
                  </div>

                  <div className="push-channel">
                    <div className="push-channel-title">
                      <span>💬 PushPlus（微信）</span>
                      <label className="ch-toggle" title="启用该渠道">
                        <input
                          type="checkbox"
                          checked={pushplusEnabled}
                          disabled={!pushplusToken.trim()}
                          onChange={(e) => setPushplusEnabled(e.target.checked)}
                        />
                        启用
                      </label>
                    </div>
                    <label className="field">
                      <input
                        type="text"
                        className="keyinput"
                        placeholder="pushplus.plus 的 token，不用可留空"
                        value={pushplusToken}
                        onChange={(e) => setPushplusToken(e.target.value)}
                      />
                    </label>
                    <p className="phone-hint">{PUSHPLUS_HINT}</p>
                    <div className="phone-btns">
                      <button
                        className="test-btn"
                        disabled={phoneBusy || !pushplusToken.trim()}
                        onClick={() => testPhone("pushplus")}
                      >
                        测试微信
                      </button>
                    </div>
                  </div>

                  <label className="row-opt indent">
                    完成阈值
                    <input
                      type="number"
                      min={0}
                      className="num"
                      value={phoneThresh}
                      onChange={(e) =>
                        setPhoneThresh(Math.max(0, Number(e.target.value) || 0))
                      }
                    />
                    秒以上
                  </label>
                  <div className="phone-btns">
                    <button
                      className="test-btn"
                      disabled={
                        phoneBusy ||
                        !(
                          (barkKey.trim() && barkEnabled) ||
                          (pushplusToken.trim() && pushplusEnabled)
                        )
                      }
                      onClick={installPhone}
                    >
                      {phone?.installed ? "更新已配置渠道" : "安装"}
                    </button>
                    {phone?.installed && (
                      <button
                        className="test-btn danger"
                        disabled={phoneBusy}
                        onClick={uninstallPhone}
                      >
                        卸载
                      </button>
                    )}
                  </div>
                  {phoneMsg && <p className="phone-msg">{phoneMsg}</p>}
                </div>
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

      <div className="view-tabs">
        <button
          className={`view-tab ${view === "launcher" ? "active" : ""}`}
          onClick={() => setView("launcher")}
        >
          启动器
        </button>
        <button
          className={`view-tab ${view === "sessions" ? "active" : ""}`}
          onClick={() => setView("sessions")}
        >
          会话监控
        </button>
        <button
          className={`view-tab ${view === "memory" ? "active" : ""}`}
          onClick={() => setView("memory")}
        >
          记忆
        </button>
        <button
          className={`view-tab ${view === "skills" ? "active" : ""}`}
          onClick={() => setView("skills")}
        >
          技能
        </button>
      </div>

      {view === "launcher" ? (
        <LauncherView />
      ) : view === "skills" ? (
        <SkillView />
      ) : view === "memory" ? (
        <MemoryView />
      ) : error ? (
        <div className="banner err">读取失败：{error}</div>
      ) : sessions.length === 0 ? (
        <div className="empty">
          {env && !env.claude_dir_exists ? (
            <>
              <p>未检测到 Claude Code</p>
              <span>
                没有找到 <code>~/.claude</code> 目录。请确认已安装 Claude Code
                并至少运行过一次。
              </span>
            </>
          ) : (
            <>
              <p>当前没有运行中的 Claude Code 会话</p>
              <span>启动一个 CC 会话后会自动出现在这里</span>
            </>
          )}
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
