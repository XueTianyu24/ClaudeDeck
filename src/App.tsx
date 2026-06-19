import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";
import logo from "./assets/logo.png";
import MemoryView from "./MemoryView";
import SkillView from "./SkillView";
import LauncherView from "./LauncherView";
import UsageView from "./UsageView";
import Markdown from "./Markdown";
import { fmtBytes, fmtCost, fmtTokens } from "./usageFormat";

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

// 旧的「运行中状态」枚举/标签已随状态表移除：会话监控改为「最近会话列表」。
// 运行中与否现由后端 list_recent_sessions 的 running 字段标记（交叉 sessions/*.json）。

type Theme = "dark" | "light";

// ── 通知设置 ──
type NotifySettings = {
  notifyDone: boolean; // 长任务完成（busy/shell → idle）
  notifyWaiting: boolean; // 等待输入（→ waiting）
  thresholdSec: number; // 完成通知的最小 busy 时长
  dingSec: number; // 提示音持续时长（循环 ding）
  mute: boolean; // 静音（关声音，仍弹窗）
  closeToTray: boolean; // 关窗时隐藏到托盘常驻（false=关窗即退出）
};

const DEFAULT_SETTINGS: NotifySettings = {
  notifyDone: true,
  notifyWaiting: true,
  thresholdSec: 30,
  dingSec: 2.5,
  mute: false,
  closeToTray: true,
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

// ── 最近会话（会话历史浏览 + 内容入口）──
type RecentSession = {
  session_id: string;
  file: string;
  cwd: string | null;
  project: string | null;
  title: string | null;
  last_prompt: string | null;
  last_active_ms: number;
  size_bytes: number;
  running: boolean;
};
type SessionMsg = { role: string; text: string; timestamp: string | null };
// 单会话成本（list_session_costs 返回，按 session_id 合并到会话行）
type SessionCost = {
  session_id: string;
  cost: number;
  message_count: number;
  total_tokens: number;
  has_unpriced: boolean;
};

// 检查更新（后端 check_for_update 返回）
type UpdateInfo = {
  current: string;
  latest: string;
  has_update: boolean;
  notes: string;
  url: string;
  published_at: string;
};
const DISMISS_KEY = "cd-update-dismissed"; // 记住「忽略此版本」，同版本不再打扰

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
    "sessions" | "memory" | "skills" | "launcher" | "usage"
  >("sessions");

  // 最近会话列表（会话监控 tab 的新主体）
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [recentErr, setRecentErr] = useState<string | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentLimit, setRecentLimit] = useState(40);
  const [expanded, setExpanded] = useState<string | null>(null); // 展开中的会话行 key
  const [tail, setTail] = useState<SessionMsg[]>([]);
  const [tailLoading, setTailLoading] = useState(false);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set()); // 折叠的项目分组 key
  // 单会话成本（session_id → SessionCost）。全量解析较重，故不进 3s 轮询，
  // 只在进入会话页 / 手动刷新时拉一次。
  const [costMap, setCostMap] = useState<Map<string, SessionCost>>(new Map());
  // 待二次确认删除的会话行 key（防误触：先点一次进入确认态，再点才真删）。
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const delTimer = useRef<number | null>(null);

  // 运行环境探测（区分没装 CC / 装了没跑；curl 可用性）
  const [env, setEnv] = useState<EnvStatus | null>(null);

  // 检查更新：启动静默查 + 设置面板手动查
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false); // 横幅里展开更新内容

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
    invoke("set_close_to_tray", { enabled: settings.closeToTray }).catch(
      () => {}
    );
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

  // 最近会话：切到「会话监控」tab 时加载，不进 3s 轮询（历史会话不必高频刷）。
  async function loadRecent(limit = recentLimit) {
    setRecentLoading(true);
    try {
      setRecent(await invoke<RecentSession[]>("list_recent_sessions", { limit }));
      setRecentErr(null);
    } catch (e) {
      setRecentErr(String(e));
    } finally {
      setRecentLoading(false);
    }
  }
  // 成本全量解析较重，单独拉、不进 3s 轮询；失败静默（成本只是会话行的附属信息）。
  async function loadCosts() {
    try {
      const list = await invoke<SessionCost[]>("list_session_costs");
      setCostMap(new Map(list.map((c) => [c.session_id, c])));
    } catch {
      /* 忽略：成本列不显示即可 */
    }
  }
  useEffect(() => {
    if (view === "sessions") {
      loadRecent();
      loadCosts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // 点开/收起某会话，展开时拉它的最后几条消息。
  // rowKey 唯一标识一行（同一会话在「最近」与「按项目」两处用不同前缀，互不牵连）。
  async function toggleExpand(rowKey: string, s: RecentSession) {
    if (expanded === rowKey) {
      setExpanded(null);
      setTail([]);
      return;
    }
    setExpanded(rowKey);
    setTail([]);
    setTailLoading(true);
    try {
      setTail(
        await invoke<SessionMsg[]>("read_session_tail", { file: s.file, max: 8 })
      );
    } catch {
      setTail([]);
    } finally {
      setTailLoading(false);
    }
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 最近 5 个会话（跨项目，纯按活跃时间倒序，不受运行中置顶影响）
  const recentTop5 = useMemo(
    () =>
      [...recent]
        .sort((a, b) => b.last_active_ms - a.last_active_ms)
        .slice(0, 5),
    [recent]
  );

  // 按项目目录（cwd）分组：组内运行中置顶再按活跃倒序；含运行中的组排前、其余按最近活跃倒序
  const groups = useMemo(() => {
    const map = new Map<string, RecentSession[]>();
    for (const s of recent) {
      const key = s.cwd || s.project || "（未知目录）";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    const arr = [...map.entries()].map(([key, items]) => {
      items.sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          b.last_active_ms - a.last_active_ms
      );
      return {
        key,
        label: items[0].project || key,
        cwd: items[0].cwd,
        items,
        running: items.some((i) => i.running),
        latest: Math.max(...items.map((i) => i.last_active_ms)),
      };
    });
    arr.sort(
      (a, b) =>
        Number(b.running) - Number(a.running) || b.latest - a.latest
    );
    return arr;
  }, [recent]);

  // 渲染单条会话行。rowKey 区分两处展示；showMeta=false 时隐藏项目/路径副行（分组内组头已带）
  function renderRow(s: RecentSession, rowKey: string, showMeta: boolean) {
    return (
      <li
        key={rowKey}
        className={`rs-row ${expanded === rowKey ? "open" : ""}`}
      >
        <div className="rs-bar" onClick={() => toggleExpand(rowKey, s)}>
          <div className="rs-info">
            <div className="rs-titleline">
              <span className="rs-caret">
                {expanded === rowKey ? "▾" : "▸"}
              </span>
              {s.running && (
                <span className="badge busy">
                  <i className="dot" />
                  运行中
                </span>
              )}
              <span className="rs-title">
                {s.title || s.last_prompt || "（未命名会话）"}
              </span>
            </div>
            {showMeta && (
              <div className="rs-subline" title={s.cwd || ""}>
                <span className="rs-proj">{s.project || "—"}</span>
                {s.cwd && <span className="rs-path">{s.cwd}</span>}
              </div>
            )}
          </div>
          <div className="rs-right">
            <div className="rs-stats">
              <span className="rs-size" title="会话记录文件大小">
                {fmtBytes(s.size_bytes)}
              </span>
              {(() => {
                const c = costMap.get(s.session_id);
                if (!c) return null;
                return (
                  <span
                    className="rs-cost"
                    title={`${c.message_count} 条 assistant 消息 · ${fmtTokens(
                      c.total_tokens
                    )} tokens${
                      c.has_unpriced ? " · 含未定价模型，成本偏低" : ""
                    }`}
                  >
                    {fmtCost(c.cost)}
                    {c.has_unpriced ? "+" : ""}
                  </span>
                );
              })()}
            </div>
            <span className="rs-ago">{fmtIdle(Date.now() - s.last_active_ms)}</span>
            <button
              className="rs-launch"
              disabled={!s.cwd}
              title={s.cwd ? `在 ${s.cwd} 启动 Claude` : "该会话无目录信息"}
              onClick={(e) => {
                e.stopPropagation();
                launchAt(s);
              }}
            >
              ▶ 在此启动
            </button>
            {(() => {
              const arming = confirmDel === rowKey;
              // 高风险：最后活跃 < 7 天 且 文件 > 1MB（近期还在用、内容多，误删损失大）。
              const highRisk =
                Date.now() - s.last_active_ms < 7 * 24 * 3600 * 1000 &&
                s.size_bytes > 1024 * 1024;
              return (
                <button
                  className={`rs-del${arming ? " confirm" : ""}${
                    arming && highRisk ? " danger" : ""
                  }`}
                  disabled={s.running}
                  title={
                    s.running
                      ? "运行中的会话不可删除"
                      : arming
                      ? highRisk
                        ? "⚠️ 高风险：该会话近 7 天活跃且体积 >1MB，删除不可恢复 — 再次点击确认"
                        : "删除不可恢复 — 再次点击确认"
                      : "删除该会话记录文件"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSessionRow(s, rowKey);
                  }}
                >
                  {arming
                    ? highRisk
                      ? "⚠️ 确认删除"
                      : "确认删除"
                    : "🗑"}
                </button>
              );
            })()}
          </div>
        </div>
        {expanded === rowKey && (
          <div className="rs-detail">
            {tailLoading ? (
              <p className="rs-loading">加载消息…</p>
            ) : tail.length === 0 ? (
              <p className="rs-loading">没有可显示的对话消息</p>
            ) : (
              tail.map((m, i) => (
                <div key={i} className={`rs-msg ${m.role}`}>
                  <div className="rs-role">
                    {m.role === "user" ? "🧑 你" : "🤖 Claude"}
                  </div>
                  <div className="rs-text">
                    <Markdown>
                      {m.text.length > 1500
                        ? m.text.slice(0, 1500) + " …（略）"
                        : m.text}
                    </Markdown>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </li>
    );
  }

  function flashLaunch(t: string) {
    setLaunchMsg(t);
    window.setTimeout(() => setLaunchMsg(null), 2800);
  }
  // 一键在该会话原目录重开 Claude（复用启动器：会带启动器里配的代理/前置命令）
  async function launchAt(s: RecentSession) {
    if (!s.cwd) return;
    try {
      await invoke("launcher_launch", { path: s.cwd });
      flashLaunch(`✅ 已在 ${s.project || s.cwd} 启动 Claude`);
      loadRecent();
    } catch (e) {
      flashLaunch("❌ " + String(e));
    }
  }

  // 删除会话：第一次点击进入确认态（4 秒后自动撤销），第二次点击才真删。
  async function deleteSessionRow(s: RecentSession, rowKey: string) {
    if (confirmDel !== rowKey) {
      setConfirmDel(rowKey);
      if (delTimer.current) window.clearTimeout(delTimer.current);
      delTimer.current = window.setTimeout(() => setConfirmDel(null), 4000);
      return;
    }
    // 已是确认态 → 执行删除
    if (delTimer.current) window.clearTimeout(delTimer.current);
    setConfirmDel(null);
    try {
      await invoke("delete_session", { file: s.file });
      if (expanded === rowKey) {
        setExpanded(null);
        setTail([]);
      }
      flashLaunch(`🗑 已删除会话：${s.title || s.last_prompt || s.session_id}`);
      loadRecent();
      loadCosts();
    } catch (e) {
      flashLaunch("❌ 删除失败：" + String(e));
    }
  }

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

  // 检查更新。manual=true 为设置面板手动触发（无论结果都给反馈，且无视「忽略」记录）；
  // 启动静默检查只在「有新版且未被忽略」时弹横幅，没网/限流静默失败不打扰。
  async function checkUpdate(manual = false) {
    setUpdateChecking(true);
    if (manual) setUpdateMsg(null);
    try {
      const info = await invoke<UpdateInfo>("check_for_update");
      setUpdate(info);
      if (manual) {
        setUpdateMsg(
          info.has_update
            ? `发现新版本 v${info.latest}`
            : `已是最新版（v${info.current}）`
        );
      } else if (info.has_update) {
        // 启动静默检查：被忽略过的版本不再弹横幅
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (dismissed === info.latest) setUpdate(null);
      }
    } catch (e) {
      if (manual) setUpdateMsg("检查失败：" + String(e));
    } finally {
      setUpdateChecking(false);
    }
  }
  useEffect(() => {
    checkUpdate(false);
  }, []);

  function dismissUpdate() {
    if (update) localStorage.setItem(DISMISS_KEY, update.latest);
    setUpdate(null);
    setShowNotes(false);
  }

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

                <label className="row-opt">
                  <input
                    type="checkbox"
                    checked={settings.closeToTray}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        closeToTray: e.target.checked,
                      }))
                    }
                  />
                  关闭窗口时最小化到托盘（后台继续监控/通知）
                </label>

                <div className="about-section">
                  <h3>ℹ️ 关于 / 检查更新</h3>
                  <p className="phone-hint">
                    当前版本 v{update?.current ?? "—"}。检查到新版会在顶部提示，便携版 / 安装版 / mac 均可手动去下载页更新。
                  </p>
                  <div className="about-row">
                    <button
                      className="test-btn"
                      disabled={updateChecking}
                      onClick={() => checkUpdate(true)}
                    >
                      {updateChecking ? "检查中…" : "检查更新"}
                    </button>
                    {updateMsg && <span className="about-msg">{updateMsg}</span>}
                  </div>
                </div>

                <div className="phone-section">
                  <h3>📱 手机推送</h3>
                  <p className="phone-hint">
                    任务完成 / 等待授权时推到手机，应用不用开着。两个渠道各自有「启用」开关，可同时推也可只留一个。
                    {phone?.installed ? " 状态：已安装 ✅" : " 状态：未安装"}
                  </p>
                  {env && !env.curl_available && (
                    <p className="phone-msg">
                      ⚠️ 未检测到 curl，手机推送将无法工作（Win10 1803
                      以下需手动安装 curl；macOS / Linux 一般自带）
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

      {update?.has_update && (
        <div className="update-bar">
          <div className="update-row">
            <span className="update-text">
              🎉 新版本 <b>v{update.latest}</b> 可用（当前 v{update.current}）
            </span>
            <div className="update-actions">
              <button
                className="update-btn ghost"
                onClick={() => setShowNotes((v) => !v)}
              >
                {showNotes ? "收起" : "查看更新内容"}
              </button>
              <button
                className="update-btn primary"
                onClick={() => openUrl(update.url).catch(() => {})}
              >
                打开下载页
              </button>
              <button className="update-btn ghost" onClick={dismissUpdate}>
                忽略此版本
              </button>
            </div>
          </div>
          {showNotes && update.notes && (
            <div className="update-notes">
              <Markdown>{update.notes}</Markdown>
            </div>
          )}
        </div>
      )}

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
        <button
          className={`view-tab ${view === "usage" ? "active" : ""}`}
          onClick={() => setView("usage")}
        >
          用量计费
        </button>
      </div>

      {view === "launcher" ? (
        <LauncherView />
      ) : view === "usage" ? (
        <UsageView />
      ) : view === "skills" ? (
        <SkillView />
      ) : view === "memory" ? (
        <MemoryView />
      ) : (
        <div className="recent-wrap">
          {(recentErr || error) && (
            <div className="banner err">{recentErr || error}</div>
          )}
          {launchMsg && <div className="banner ok">{launchMsg}</div>}
          <div className="recent-head">
            <span className="recent-hint">
              最近 5 个会话 + 按项目目录分组 — 点开看最后几条消息，▶ 在原目录重新打开
            </span>
            <button
              className="refresh"
              onClick={() => {
                loadRecent();
                loadCosts();
              }}
              title="刷新"
            >
              ↻
            </button>
          </div>
          {recent.length === 0 ? (
            <div className="empty">
              {recentLoading ? (
                <p>加载中…</p>
              ) : env && !env.claude_dir_exists ? (
                <>
                  <p>未检测到 Claude Code</p>
                  <span>
                    没有找到 <code>~/.claude</code> 目录。请确认已安装 Claude
                    Code 并至少运行过一次。
                  </span>
                </>
              ) : (
                <>
                  <p>还没有历史会话</p>
                  <span>在任意目录跑过 Claude Code 后，会话会出现在这里</span>
                </>
              )}
            </div>
          ) : (
            <>
              <section className="rs-section">
                <h3 className="rs-section-title">⏱ 最近会话</h3>
                <ul className="rs-list">
                  {recentTop5.map((s) => renderRow(s, `top:${s.file}`, true))}
                </ul>
              </section>

              <section className="rs-section">
                <h3 className="rs-section-title">
                  📁 按项目浏览 · {groups.length} 个目录
                </h3>
                {groups.map((g) => (
                  <div key={g.key} className="rs-group">
                    <div
                      className="rs-group-head"
                      onClick={() => toggleGroup(g.key)}
                    >
                      <span className="rs-caret">
                        {collapsedGroups.has(g.key) ? "▸" : "▾"}
                      </span>
                      {g.running && (
                        <span className="badge busy">
                          <i className="dot" />
                          运行中
                        </span>
                      )}
                      <span className="rs-group-name">{g.label}</span>
                      <span className="rs-group-count">{g.items.length}</span>
                      {g.cwd && (
                        <span className="rs-group-path" title={g.cwd}>
                          {g.cwd}
                        </span>
                      )}
                    </div>
                    {!collapsedGroups.has(g.key) && (
                      <ul className="rs-list rs-group-list">
                        {g.items.map((s) =>
                          renderRow(s, `grp:${s.file}`, false)
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </section>
              {recent.length >= recentLimit && (
                <div className="rs-more">
                  <button
                    className="lc-btn"
                    onClick={() => {
                      const n = recentLimit + 40;
                      setRecentLimit(n);
                      loadRecent(n);
                    }}
                  >
                    加载更多
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

export default App;
