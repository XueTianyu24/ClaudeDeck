import { useEffect, useMemo, useRef, useState } from "react";
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
import UsageView from "./UsageView";
import Markdown from "./Markdown";
import SessionFullView from "./SessionFullView";
import {
  Apple,
  Archive,
  Bot,
  FileText,
  FolderOpen,
  History,
  Info,
  MessageCircle,
  Monitor,
  Moon,
  RotateCw,
  Search,
  Settings,
  Smartphone,
  Star,
  Sun,
  Trash2,
  User,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { check as pluginCheckUpdate } from "@tauri-apps/plugin-updater";
import UpdateModal, { type UpdateData, type UpdateInfo } from "./UpdateModal";
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
// 收藏的会话（后端 favorites_list 返回，running/missing 实时计算）
type FavoriteView = {
  session_id: string;
  file: string;
  cwd: string | null;
  project: string | null;
  title: string | null;
  added_at: number;
  running: boolean;
  missing: boolean;
  size_bytes: number;
  last_active_ms: number;
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

const DISMISS_KEY = "cd-update-dismissed"; // 记住「忽略此版本」，同版本不再打扰
// 更新检查/下载走的代理（可选）。更新源在 GitHub 资产 CDN（objects.githubusercontent.com），
// 国内网络时通时断——配上本地代理后检查和下载都稳定走代理。
const UPDATE_PROXY_KEY = "cd-update-proxy";

// 「按项目浏览」分组默认折叠；展开过哪些组记 localStorage，重启后保持。
const GROUPS_EXPANDED_KEY = "cd-groups-expanded";
function loadExpandedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUPS_EXPANDED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* 坏数据当作全折叠 */
  }
  return new Set();
}
function saveExpandedGroups(next: Set<string>) {
  try {
    localStorage.setItem(GROUPS_EXPANDED_KEY, JSON.stringify([...next]));
  } catch {
    /* 存不上就只在本次会话生效 */
  }
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false); // 右上角 ↻ 手动刷新中（转圈反馈）
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("cd-theme") as Theme) || "dark"
  );
  const [settings, setSettings] = useState<NotifySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<
    "sessions" | "memory" | "skills" | "launcher" | "usage" | "notify"
  >("sessions");

  // 最近会话列表（会话监控 tab 的新主体）
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const [recentErr, setRecentErr] = useState<string | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // 展开中的会话行 key
  const [tail, setTail] = useState<SessionMsg[]>([]);
  const [tailLoading, setTailLoading] = useState(false);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);
  // 展开中的项目分组 key（默认全折叠，展开状态持久化）
  const [expandedGroups, setExpandedGroups] =
    useState<Set<string>>(loadExpandedGroups);
  const [recentPage, setRecentPage] = useState(0); // 「最近会话」当前页（每页 5 个）
  const [query, setQuery] = useState(""); // 会话检索关键词（后端全文检索）
  const [searchWeeks, setSearchWeeks] = useState(3); // 检索时间范围（周），0=全部
  const [searchResults, setSearchResults] = useState<RecentSession[]>([]);
  const [searching, setSearching] = useState(false);
  const [fullView, setFullView] = useState<RecentSession | null>(null); // 全文查看的会话
  const [favs, setFavs] = useState<FavoriteView[]>([]); // 收藏的会话
  const [favCollapsed, setFavCollapsed] = useState(false); // 收藏夹是否折叠
  // 单会话成本（session_id → SessionCost）。全量解析较重，故不进 3s 轮询，
  // 只在进入会话页 / 手动刷新时拉一次。
  const [costMap, setCostMap] = useState<Map<string, SessionCost>>(new Map());
  // 待二次确认删除的会话行 key（防误触：先点一次进入确认态，再点才真删）。
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const delTimer = useRef<number | null>(null);

  // 运行环境探测（区分没装 CC / 装了没跑；curl 可用性）
  const [env, setEnv] = useState<EnvStatus | null>(null);

  // 检查更新：启动静默查 + 设置面板手动查（官方插件为主，GitHub API 兜底）
  const [update, setUpdate] = useState<UpdateData | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false); // 更新弹窗开关
  const [appVersion, setAppVersion] = useState(""); // 当前版本号（关于区显示）
  // 更新代理（存 localStorage，检查更新与下载安装都用它）
  const [updateProxy, setUpdateProxy] = useState(
    () => localStorage.getItem(UPDATE_PROXY_KEY) || ""
  );

  // 会话记录保留期（CC cleanupPeriodDays；null = 未配置走默认 30 天）
  const [cleanupDays, setCleanupDays] = useState<number | null>(null);
  const [cleanupInput, setCleanupInput] = useState("30");
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

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

  // 主题的真相在后端 ui-prefs.json（同步落盘），localStorage 只是首屏免闪烁的快取：
  // webview 的 localStorage 延迟批量写盘，托盘退出 / taskkill 会吞掉刚切的值。
  // 后端值读回来之前先不回写，避免用 localStorage 的旧值覆盖掉后端的新值。
  const themeLoaded = useRef(false);
  useEffect(() => {
    invoke<{ theme: string }>("get_ui_prefs")
      .then((p) => {
        if (p.theme === "dark" || p.theme === "light") setTheme(p.theme);
        else invoke("set_ui_theme", { theme }).catch(() => {}); // 空串=老用户首次升级，把当前值迁进去
        themeLoaded.current = true;
      })
      .catch(() => {
        themeLoaded.current = true;
      });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cd-theme", theme);
    if (themeLoaded.current) invoke("set_ui_theme", { theme }).catch(() => {});
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

  // 右上角 ↻ 手动刷新：转圈给出可见反馈，并连带刷新「当前视图」的内容，
  // 避免只刷了头部活动会话数、当前页看着「点了没反应」。
  // （3s 轮询仍走轻量的 refresh()，不把重活〔成本全量解析〕拉进高频轮询。）
  async function manualRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    const started = Date.now();
    try {
      await refresh();
      if (view === "sessions") {
        await Promise.all([loadRecent(), loadCosts(), loadFavs()]);
      }
    } finally {
      // 太快看不到转圈，保证至少转 500ms 再停
      const elapsed = Date.now() - started;
      if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed));
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // 最近会话：切到「会话监控」tab 时加载，不进 3s 轮询（历史会话不必高频刷）。
  // limit=0 = 全量：「按项目浏览」直接列全所有目录/会话，免去一次次点加载更多；
  // 每会话后端只读头尾小块，全量也轻（比成本解析轻得多）。
  async function loadRecent() {
    setRecentLoading(true);
    try {
      setRecent(
        await invoke<RecentSession[]>("list_recent_sessions", { limit: 0 })
      );
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
  // 收藏夹：切到会话监控 tab 时拉一次；增删后也会重拉。
  async function loadFavs() {
    try {
      setFavs(await invoke<FavoriteView[]>("favorites_list"));
    } catch {
      /* 忽略：收藏夹不显示即可 */
    }
  }
  useEffect(() => {
    if (view === "sessions") {
      loadRecent();
      loadCosts();
      loadFavs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // 会话全文检索：关键词/范围变化时 debounce 400ms 调后端（扫文件有延迟，不每键一扫）。
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await invoke<RecentSession[]>("search_sessions", {
          query: q,
          weeks: searchWeeks,
        });
        setSearchResults(res);
        setRecentErr(null);
      } catch (e) {
        setRecentErr(String(e));
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [query, searchWeeks]);

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
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveExpandedGroups(next);
      return next;
    });
  }

  // 已收藏的 session_id 集合（会话行的 ★/☆ 状态判定）
  const favSet = useMemo(
    () => new Set(favs.map((f) => f.session_id)),
    [favs]
  );

  // 最近 15 个会话（跨项目，纯按活跃时间倒序，不受运行中置顶影响），分页每页 5 个
  const recentTop15 = useMemo(
    () =>
      [...recent]
        .sort((a, b) => b.last_active_ms - a.last_active_ms)
        .slice(0, 15),
    [recent]
  );
  const RECENT_PAGE_SIZE = 5;
  const recentPageCount = Math.max(
    1,
    Math.ceil(recentTop15.length / RECENT_PAGE_SIZE)
  );
  // 数据变化可能让当前页超界 → 渲染用 clamp 后的有效页，翻页基于它
  const recentPageClamped = Math.min(recentPage, recentPageCount - 1);
  const recentPageItems = recentTop15.slice(
    recentPageClamped * RECENT_PAGE_SIZE,
    recentPageClamped * RECENT_PAGE_SIZE + RECENT_PAGE_SIZE
  );
  const goRecentPage = (p: number) =>
    setRecentPage(Math.max(0, Math.min(p, recentPageCount - 1)));

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
              className={`rs-fav${favSet.has(s.session_id) ? " on" : ""}`}
              title={
                favSet.has(s.session_id)
                  ? "取消收藏"
                  : "加入收藏夹（关机后一键续上）"
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleFav(s);
              }}
            >
              <Star
                size={14}
                fill={favSet.has(s.session_id) ? "currentColor" : "none"}
              />
            </button>
            <button
              className="rs-launch"
              disabled={!s.cwd || s.running}
              title={
                !s.cwd
                  ? "该会话无目录信息"
                  : s.running
                  ? "运行中的会话已在终端打开，无需继续"
                  : `续上该会话（claude --resume）`
              }
              onClick={(e) => {
                e.stopPropagation();
                resumeSession(s.cwd, s.session_id, s.project, s.running);
              }}
            >
              <RotateCw size={13} /> 一键继续
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
                  {arming ? (
                    highRisk ? (
                      "⚠️ 确认删除"
                    ) : (
                      "确认删除"
                    )
                  ) : (
                    <Trash2 size={13} />
                  )}
                </button>
              );
            })()}
          </div>
        </div>
        {renderDetail(s, rowKey)}
      </li>
    );
  }

  // 展开的会话详情（最近几条预览 + 查看全文入口）。最近会话行与收藏夹行共用。
  function renderDetail(s: RecentSession, rowKey: string) {
    if (expanded !== rowKey) return null;
    return (
      <div className="rs-detail">
        <div className="rs-detail-bar">
          <span className="rs-detail-hint">最近几条预览</span>
          <button
            className="rs-fulltext"
            onClick={(e) => {
              e.stopPropagation();
              setFullView(s);
            }}
          >
            <FileText size={13} /> 查看全文
          </button>
        </div>
        {tailLoading ? (
          <p className="rs-loading">加载消息…</p>
        ) : tail.length === 0 ? (
          <p className="rs-loading">没有可显示的对话消息</p>
        ) : (
          tail.map((m, i) => (
            <div key={i} className={`rs-msg ${m.role}`}>
              <div className={`cd-avatar ${m.role}`}>
                {m.role === "user" ? <User size={15} /> : <Bot size={15} />}
              </div>
              <div className="rs-msg-body">
                <div className="rs-role">
                  {m.role === "user" ? "你" : "Claude"}
                </div>
                <div className="rs-text">
                  <Markdown>
                    {m.text.length > 1500
                      ? m.text.slice(0, 1500) + " …（略）"
                      : m.text}
                  </Markdown>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    );
  }

  // 收藏项 → RecentSession 形状（展开预览 / 查看全文共用同一套组件与后端命令）。
  function favAsSession(f: FavoriteView): RecentSession {
    return {
      session_id: f.session_id,
      file: f.file,
      cwd: f.cwd,
      project: f.project,
      title: f.title,
      last_prompt: null,
      last_active_ms: f.last_active_ms || f.added_at * 1000,
      size_bytes: f.size_bytes,
      running: f.running,
    };
  }

  // 渲染收藏夹里的一条（标题 + 项目 + 一键继续 + 取消收藏；点行展开对话预览）
  function renderFavRow(f: FavoriteView) {
    const rowKey = `fav:${f.session_id}`;
    return (
      <li
        key={rowKey}
        className={`fav-row${f.missing ? " gone" : ""}${
          expanded === rowKey ? " open" : ""
        }`}
      >
        <div
          className="fav-info"
          onClick={() => {
            if (!f.missing) toggleExpand(rowKey, favAsSession(f));
          }}
          title={f.missing ? undefined : "点击查看对话内容"}
        >
          <div className="fav-titleline">
            {!f.missing && (
              <span className="rs-caret">
                {expanded === rowKey ? "▾" : "▸"}
              </span>
            )}
            {f.running && (
              <span className="badge busy">
                <i className="dot" />
                运行中
              </span>
            )}
            <span className="fav-title">{f.title || "（未命名会话）"}</span>
          </div>
          <div className="fav-subline" title={f.cwd || ""}>
            <span className="rs-proj">{f.project || "—"}</span>
            {f.missing && <span className="fav-gone">⚠️ 会话记录已不存在</span>}
          </div>
        </div>
        <div className="fav-actions">
          {!f.missing && (
            <>
              <div className="rs-stats">
                <span className="rs-size" title="会话记录文件大小">
                  {fmtBytes(f.size_bytes)}
                </span>
                {(() => {
                  const c = costMap.get(f.session_id);
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
              <span className="rs-ago">
                {fmtIdle(Date.now() - f.last_active_ms)}
              </span>
            </>
          )}
          <button
            className="rs-launch"
            disabled={!f.cwd || f.running || f.missing}
            title={
              f.missing
                ? "会话记录已被删除，无法继续"
                : !f.cwd
                ? "该会话无目录信息"
                : f.running
                ? "运行中的会话已在终端打开，无需继续"
                : "续上该会话（claude --resume）"
            }
            onClick={() =>
              resumeSession(f.cwd, f.session_id, f.project, f.running)
            }
          >
            <RotateCw size={13} /> 一键继续
          </button>
          <button
            className="rs-fav on"
            title="从收藏夹移除"
            onClick={() => removeFav(f.session_id)}
          >
            <Star size={14} fill="currentColor" />
          </button>
        </div>
        {renderDetail(favAsSession(f), rowKey)}
      </li>
    );
  }

  function flashLaunch(t: string) {
    setLaunchMsg(t);
    window.setTimeout(() => setLaunchMsg(null), 2800);
  }
  // 一键续会话：在原目录跑 `claude --resume <id>`，复用启动器的代理/前置命令与 WT 设置。
  async function resumeSession(
    cwd: string | null,
    sessionId: string,
    project: string | null,
    running: boolean
  ) {
    if (!cwd) return;
    if (running) {
      flashLaunch("⚠️ 该会话仍在运行中，已在终端打开，无需继续");
      return;
    }
    try {
      await invoke("launcher_resume", { path: cwd, sessionId });
      flashLaunch(`✅ 已续上会话：${project || cwd}`);
    } catch (e) {
      flashLaunch("❌ " + String(e));
    }
  }

  // 加入 / 取消收藏（按 session_id 判定当前是否已收藏）。
  async function toggleFav(s: RecentSession) {
    try {
      if (favSet.has(s.session_id)) {
        await invoke("favorites_remove", { sessionId: s.session_id });
      } else {
        await invoke("favorites_add", {
          sessionId: s.session_id,
          file: s.file,
          cwd: s.cwd,
          project: s.project,
          title: s.title || s.last_prompt,
        });
        flashLaunch("⭐ 已加入收藏夹");
      }
      loadFavs();
    } catch (e) {
      flashLaunch("❌ " + String(e));
    }
  }

  // 从收藏夹移除一条。
  async function removeFav(sessionId: string) {
    try {
      await invoke("favorites_remove", { sessionId });
      loadFavs();
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
  // 启动静默检查只在「有新版且未被忽略」时弹窗，没网/限流静默失败不打扰。
  // 主路径 = 官方 tauri-plugin-updater（latest.json + 签名验证，可一键下载安装）；
  // 插件检查失败（某版没传 latest.json / mac 未签名等）→ 兜底 GitHub API，只能开下载页。
  async function checkUpdate(manual = false) {
    setUpdateChecking(true);
    if (manual) setUpdateMsg(null);
    try {
      let found: UpdateData | null = null;
      // 插件检查失败自动重试一次（隔 2s）：瞬时网络抖动 / 发版时 latest.json 刚好
      // 还没传完，都不该直接掉到「打开下载页」兜底。
      let up: Awaited<ReturnType<typeof pluginCheckUpdate>> = null;
      let pluginOk = false;
      const proxy = updateProxy.trim() || undefined;
      for (let attempt = 0; attempt < 2 && !pluginOk; attempt++) {
        try {
          up = await pluginCheckUpdate({ timeout: 15000, proxy });
          pluginOk = true;
        } catch (e) {
          console.warn(`[updater] 插件检查失败（第 ${attempt + 1} 次）`, e);
          if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (pluginOk) {
        if (up) {
          found = {
            current: up.currentVersion,
            latest: up.version,
            notes: up.body ?? "",
            url: "https://github.com/XueTianyu24/ClaudeDeck/releases/latest",
            update: up,
          };
        }
      } else {
        // 插件路径两次都失败 → GitHub API 兜底探测（无一键安装，弹窗退化为「打开下载页」）。
        const info = await invoke<UpdateInfo>("check_for_update");
        if (info.has_update) {
          found = {
            current: info.current,
            latest: info.latest,
            notes: info.notes,
            url: info.url,
            update: null,
          };
        }
      }
      if (found) {
        // 手动检查无视「忽略」记录；启动静默检查则被忽略过的版本不再弹。
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (manual || dismissed !== found.latest) {
          setUpdate(found);
          setUpdateModalOpen(true);
        } else {
          setUpdate(null);
        }
      } else {
        setUpdate(null);
      }
      if (manual) {
        setUpdateMsg(
          found
            ? `发现新版本 v${found.latest}`
            : `已是最新版（v${appVersion || "当前版本"}）`
        );
      }
    } catch (e) {
      if (manual) setUpdateMsg("检查失败：" + String(e));
    } finally {
      setUpdateChecking(false);
    }
  }
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
    checkUpdate(false);
    invoke<{ period_days: number | null }>("get_cleanup_config")
      .then((c) => {
        setCleanupDays(c.period_days);
        if (c.period_days) setCleanupInput(String(c.period_days));
      })
      .catch(() => {});
  }, []);

  // 保存会话保留期；days=null 恢复 CC 默认（30 天）。删除发生在下次启动 claude 时。
  async function saveCleanup(days: number | null) {
    if (days !== null && (!Number.isFinite(days) || days < 1 || days > 36500)) {
      setCleanupMsg("请输入 1–36500 之间的天数");
      return;
    }
    try {
      await invoke("set_cleanup_period", { days });
      setCleanupDays(days);
      if (days !== null) setCleanupInput(String(days));
      else setCleanupInput("30");
      setCleanupMsg(
        days === null
          ? "✅ 已恢复默认（保留 30 天），下次启动 claude 生效"
          : `✅ 已设为保留 ${days} 天，下次启动 claude 生效`
      );
    } catch (e) {
      setCleanupMsg("❌ " + String(e));
    }
  }

  function dismissUpdate() {
    if (update) localStorage.setItem(DISMISS_KEY, update.latest);
    setUpdate(null);
    setUpdateModalOpen(false);
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
            <h1>Beacon</h1>
            <p className="subtitle">Beacon for Claude Code</p>
          </div>
        </div>
        <div className="meta">
          <span className="count">
            {liveCount > 0 && <span className="beacon-dot" />}
            {liveCount} 个活动会话
          </span>
          <span className="sync">
            {lastSync ? `已同步 ${fmtIdle(Date.now() - lastSync)}` : "同步中…"}
          </span>
          <div className="settings-wrap">
            <button
              className={`refresh ${showSettings ? "active" : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              title="设置"
            >
              <Settings size={15} />
            </button>
            {showSettings && (
              <div className="settings-panel">
                <h3>
                  <Settings size={13} /> 通用设置
                </h3>
                <p className="phone-hint">
                  桌面通知与手机推送已移到「通知」标签页配置。
                </p>
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
                  <h3>
                    <Archive size={13} /> 会话记录保留
                  </h3>
                  <p className="phone-hint">
                    Claude Code 启动时会自动删除超过保留期的会话记录（官方默认
                    30 天，删除不可恢复）。当前：
                    <b>
                      {cleanupDays === null
                        ? "默认（30 天）"
                        : cleanupDays >= 36500
                        ? "永久保留"
                        : `保留 ${cleanupDays} 天`}
                    </b>
                  </p>
                  <div className="cleanup-row">
                    <input
                      type="number"
                      min={1}
                      max={36500}
                      className="num"
                      value={cleanupInput}
                      onChange={(e) => setCleanupInput(e.target.value)}
                    />
                    天
                    <button
                      className="test-btn"
                      onClick={() => saveCleanup(Number(cleanupInput))}
                    >
                      保存
                    </button>
                  </div>
                  <div className="cleanup-presets">
                    <button className="rs-link-btn" onClick={() => saveCleanup(90)}>
                      90 天
                    </button>
                    <button
                      className="rs-link-btn"
                      onClick={() => saveCleanup(365)}
                    >
                      1 年
                    </button>
                    <button
                      className="rs-link-btn"
                      onClick={() => saveCleanup(36500)}
                    >
                      永久
                    </button>
                    <button
                      className="rs-link-btn"
                      onClick={() => saveCleanup(null)}
                    >
                      恢复默认
                    </button>
                  </div>
                  <p className="phone-hint">
                    ⚠️ 调小保留期会在下次启动 claude 时删掉更早的会话记录，收藏夹里超期的会话也会失效。
                  </p>
                  {cleanupMsg && <p className="phone-msg">{cleanupMsg}</p>}
                </div>

                <div className="about-section">
                  <h3>
                    <Info size={13} /> 关于 / 检查更新
                  </h3>
                  <p className="phone-hint">
                    当前版本 v{appVersion || "—"}。检查到新版会自动弹窗，安装版可一键下载安装（带签名验证）并自动重启；便携版去下载页手动更新。
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
                  <label className="field">
                    <input
                      type="text"
                      className="keyinput"
                      placeholder="更新代理（可选，如 http://127.0.0.1:7897）"
                      value={updateProxy}
                      onChange={(e) => {
                        setUpdateProxy(e.target.value);
                        try {
                          localStorage.setItem(
                            UPDATE_PROXY_KEY,
                            e.target.value.trim()
                          );
                        } catch {
                          /* 存不上则仅本次生效 */
                        }
                      }}
                    />
                  </label>
                  <p className="phone-hint">
                    更新源在 GitHub，国内网络时通时断；填本地代理（与启动器代理一致即可）后检查更新和下载安装都会稳定走代理。
                  </p>
                </div>

              </div>
            )}
          </div>
          <button
            className="refresh"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "切换到浅色" : "切换到深色"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={14} />}
          </button>
          <button
            className="refresh"
            onClick={manualRefresh}
            disabled={refreshing}
            title="立即刷新"
          >
            <span className={refreshing ? "spin" : ""}>↻</span>
          </button>
        </div>
      </header>

      {update && updateModalOpen && (
        <UpdateModal
          data={update}
          onDismiss={dismissUpdate}
          onLater={() => setUpdateModalOpen(false)}
        />
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
        <button
          className={`view-tab ${view === "notify" ? "active" : ""}`}
          onClick={() => setView("notify")}
        >
          通知
        </button>
      </div>

      {view === "launcher" ? (
        <LauncherView />
      ) : view === "usage" ? (
        <UsageView />
      ) : view === "notify" ? (
        <div className="notify-wrap">
          <div className="notify-grid">
            <section className="notify-card">
              <h3>
                <Monitor size={14} /> 桌面通知
              </h3>
              <p className="phone-hint">
                会话完成 / 等待输入时弹系统通知 + 提示音。app 需在运行（关窗到托盘也算）。
              </p>
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
            </section>

            <section className="notify-card">
              <h3>
                <Smartphone size={14} /> 手机推送
              </h3>
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
                  <span>
                    <Apple size={13} /> Bark（iPhone，免费）
                  </span>
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
                  <span>
                    <MessageCircle size={13} /> PushPlus（微信）
                  </span>
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
            </section>
          </div>
        </div>
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
              最近 15 个会话（每页 5 个）+ 按项目目录分组 — 点开看最后几条消息，一键续上原会话，收藏关机后再续
            </span>
            <div className="recent-actions">
              <div className="rs-search-box">
                <input
                  className="rs-search"
                  type="search"
                  placeholder="全文搜索会话内容…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setRecentPage(0);
                  }}
                />
                {query && (
                  <button
                    className="rs-search-x"
                    onClick={() => {
                      setQuery("");
                      setRecentPage(0);
                    }}
                    title="清空搜索"
                  >
                    ✕
                  </button>
                )}
              </div>
              <select
                className="rs-weeks"
                value={searchWeeks}
                onChange={(e) => setSearchWeeks(Number(e.target.value))}
                title="检索时间范围（范围越小越快）"
              >
                <option value={1}>近 1 周</option>
                <option value={2}>近 2 周</option>
                <option value={3}>近 3 周</option>
                <option value={12}>近 3 月</option>
                <option value={0}>全部</option>
              </select>
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
          </div>
          {favs.length > 0 && (
            <section className="rs-section fav-section">
              <div
                className="rs-section-bar fav-bar"
                onClick={() => setFavCollapsed((v) => !v)}
              >
                <h3 className="rs-section-title">
                  <span className="rs-caret">{favCollapsed ? "▸" : "▾"}</span>
                  <Star size={14} fill="currentColor" /> 收藏夹 · {favs.length}
                </h3>
                <span className="fav-hint">关机前收藏未聊完的会话，回来一键续上</span>
              </div>
              {!favCollapsed && (
                <ul className="rs-list fav-list">{favs.map(renderFavRow)}</ul>
              )}
            </section>
          )}
          {query.trim() ? (
            <section className="rs-section">
              <div className="rs-section-bar">
                <h3 className="rs-section-title">
                  <Search size={14} /> 搜索「{query.trim()}」·{" "}
                  {searching ? "搜索中…" : `${searchResults.length} 个结果`}
                </h3>
              </div>
              {searching ? (
                <p className="rs-loading">搜索中…（时间范围越小越快）</p>
              ) : searchResults.length === 0 ? (
                <div className="empty">
                  <p>没有匹配「{query.trim()}」的会话</p>
                  <span>换个关键词，或把右上角时间范围调大（含「全部」）</span>
                </div>
              ) : (
                <ul className="rs-list">
                  {searchResults.map((s) =>
                    renderRow(s, `search:${s.file}`, true)
                  )}
                </ul>
              )}
            </section>
          ) : recent.length === 0 ? (
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
                <div className="rs-section-bar">
                  <h3 className="rs-section-title">
                    <History size={14} /> 最近会话 · {recentTop15.length}
                  </h3>
                  {recentPageCount > 1 && (
                    <div className="rs-pager">
                      <button
                        className="rs-page-btn"
                        disabled={recentPageClamped === 0}
                        onClick={() => goRecentPage(recentPageClamped - 1)}
                        title="上一页"
                      >
                        ‹
                      </button>
                      <span className="rs-page-ind">
                        {recentPageClamped + 1} / {recentPageCount}
                      </span>
                      <button
                        className="rs-page-btn"
                        disabled={recentPageClamped >= recentPageCount - 1}
                        onClick={() => goRecentPage(recentPageClamped + 1)}
                        title="下一页"
                      >
                        ›
                      </button>
                    </div>
                  )}
                </div>
                <ul className="rs-list">
                  {recentPageItems.map((s) =>
                    renderRow(s, `top:${s.file}`, true)
                  )}
                </ul>
              </section>

              <section className="rs-section">
                <div className="rs-section-bar">
                  <h3 className="rs-section-title">
                    <FolderOpen size={14} /> 按项目浏览 · {groups.length} 个目录
                  </h3>
                  <div className="rs-group-actions">
                    <button
                      className="rs-link-btn"
                      onClick={() => {
                        const all = new Set(groups.map((g) => g.key));
                        saveExpandedGroups(all);
                        setExpandedGroups(all);
                      }}
                    >
                      全部展开
                    </button>
                    <button
                      className="rs-link-btn"
                      onClick={() => {
                        saveExpandedGroups(new Set());
                        setExpandedGroups(new Set());
                      }}
                    >
                      全部折叠
                    </button>
                  </div>
                </div>
                {groups.map((g) => (
                  <div key={g.key} className="rs-group">
                    <div
                      className="rs-group-head"
                      onClick={() => toggleGroup(g.key)}
                    >
                      <span className="rs-caret">
                        {expandedGroups.has(g.key) ? "▾" : "▸"}
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
                    {expandedGroups.has(g.key) && (
                      <ul className="rs-list rs-group-list">
                        {g.items.map((s) =>
                          renderRow(s, `grp:${s.file}`, false)
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      )}
      {fullView && (
        <SessionFullView
          file={fullView.file}
          title={
            fullView.title || fullView.last_prompt || fullView.session_id
          }
          onClose={() => setFullView(null)}
        />
      )}
    </main>
  );
}

export default App;
