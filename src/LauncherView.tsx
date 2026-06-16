import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import WarmupScheduler from "./WarmupScheduler";

// ClaudeDeck 自有配置：%APPDATA%\ClaudeDeck\launcher.json，独立存储。

type RecentDir = { path: string; last_opened_at: number };
type LauncherConfig = {
  recent_dirs: RecentDir[];
  pre_cmd_enabled: boolean;
  pre_cmd: string;
  use_wt: boolean;
};

// 「重置」按钮用的默认前置命令，按平台给：Windows = PowerShell，macOS/Linux = bash export。
// 与后端 LAUNCHER_DEFAULT_PRE_CMD 保持一致。
const DEFAULT_PRE_CMD_WIN =
  '$env:HTTP_PROXY = "http://127.0.0.1:7897"\r\n$env:HTTPS_PROXY = "http://127.0.0.1:7897"\r\n$env:ALL_PROXY = "http://127.0.0.1:7897"';
const DEFAULT_PRE_CMD_UNIX =
  "export HTTP_PROXY=http://127.0.0.1:7897\nexport HTTPS_PROXY=http://127.0.0.1:7897\nexport ALL_PROXY=http://127.0.0.1:7897";

// last_opened_at 是 unix 秒
function fmtAgo(secs: number): string {
  if (!secs) return "";
  const d = Math.floor(Date.now() / 1000 - secs);
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)} 个月前`;
  return `${Math.floor(d / 86400 / 365)} 年前`;
}

function folderName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export default function LauncherView() {
  const [cfg, setCfg] = useState<LauncherConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [os, setOs] = useState<string>("");

  useEffect(() => {
    invoke<string>("get_platform").then(setOs).catch(() => {});
  }, []);
  const isWindows = os === "windows";
  const defaultPreCmd = isWindows ? DEFAULT_PRE_CMD_WIN : DEFAULT_PRE_CMD_UNIX;

  async function reload() {
    try {
      const c = await invoke<LauncherConfig>("launcher_get_config");
      setCfg(c);
      if (c.recent_dirs.length && !selected) {
        setSelected(c.recent_dirs[0].path);
      }
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  function flash(t: string) {
    setMsg(t);
    window.setTimeout(() => setMsg(null), 2500);
  }

  async function addDir() {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;
      const c = await invoke<LauncherConfig>("launcher_add_dir", {
        path: picked,
      });
      setCfg(c);
      setSelected(picked);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function removeDir(path: string) {
    try {
      const c = await invoke<LauncherConfig>("launcher_remove_dir", { path });
      setCfg(c);
      if (selected === path) setSelected(c.recent_dirs[0]?.path ?? null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function launch(path: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await invoke<LauncherConfig>("launcher_launch", { path });
      setCfg(c);
      setSelected(path);
      flash(`✅ 已在 ${folderName(path)} 启动 Claude`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function savePrecmd(next: Partial<LauncherConfig>) {
    if (!cfg) return;
    const merged = { ...cfg, ...next };
    setCfg(merged);
    try {
      await invoke("launcher_save_precmd", {
        enabled: merged.pre_cmd_enabled,
        preCmd: merged.pre_cmd,
      });
    } catch (e) {
      setErr(String(e));
    }
  }

  async function saveUseWt(enabled: boolean) {
    if (!cfg) return;
    setCfg({ ...cfg, use_wt: enabled });
    try {
      await invoke("launcher_set_use_wt", { enabled });
    } catch (e) {
      setErr(String(e));
    }
  }

  if (!cfg) {
    return (
      <div className="launcher">
        {err ? (
          <div className="banner err">读取启动器配置失败：{err}</div>
        ) : (
          <div className="empty">
            <p>加载中…</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="launcher">
      <div className="launcher-head">
        <div className="launcher-title">
          <h2>Claude 启动器</h2>
          <p>选一个工作目录，双击或「启动」即在该目录开一个新的 Claude 会话</p>
        </div>
        <button className="lc-btn primary" onClick={addDir}>
          + 添加目录
        </button>
      </div>

      {err && <div className="banner err">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}

      {cfg.recent_dirs.length === 0 ? (
        <div className="empty">
          <p>还没有最近目录</p>
          <span>点右上角「添加目录」选一个项目文件夹开始</span>
        </div>
      ) : (
        <ul className="lc-list">
          {cfg.recent_dirs.map((r) => (
            <li
              key={r.path}
              className={`lc-row ${selected === r.path ? "sel" : ""}`}
              onClick={() => setSelected(r.path)}
              onDoubleClick={() => launch(r.path)}
              title={r.path}
            >
              <div className="lc-info">
                <div className="lc-name">{folderName(r.path)}</div>
                <div className="lc-path">{r.path}</div>
              </div>
              <div className="lc-ago">{fmtAgo(r.last_opened_at)}</div>
              <div className="lc-actions">
                <button
                  className="lc-btn primary"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    launch(r.path);
                  }}
                >
                  启动
                </button>
                <button
                  className="lc-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeDir(r.path);
                  }}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="lc-precmd">
        {isWindows && (
          <label className="lc-check">
            <input
              type="checkbox"
              checked={cfg.use_wt}
              onChange={(e) => saveUseWt(e.target.checked)}
            />
            在 Windows Terminal 中打开（所有会话集中到一个专属「ClaudeDeck」窗口的多个 tab，免手动切窗口；未装 WT 自动退回独立窗口）
          </label>
        )}
        <label className="lc-check">
          <input
            type="checkbox"
            checked={cfg.pre_cmd_enabled}
            onChange={(e) =>
              savePrecmd({ pre_cmd_enabled: e.target.checked })
            }
          />
          启动前运行命令（如注入代理环境变量，仅作用于该终端）
        </label>
        <div className="lc-precmd-row">
          <textarea
            className="lc-textarea"
            value={cfg.pre_cmd}
            disabled={!cfg.pre_cmd_enabled}
            spellCheck={false}
            rows={4}
            onChange={(e) => setCfg({ ...cfg, pre_cmd: e.target.value })}
            onBlur={() => savePrecmd({})}
          />
          <button
            className="lc-btn"
            onClick={() => savePrecmd({ pre_cmd: defaultPreCmd })}
          >
            重置
          </button>
        </div>
        <p className="lc-hint">
          {isWindows ? (
            <>
              Windows：默认把所有会话开进一个专属「ClaudeDeck」窗口的新 tab
              （<code>wt -w ClaudeDeck new-tab</code>，没有就建、有就往里加），自动切到项目目录
              + 注入上面的代理命令 + 起 claude——和你其他 WT 窗口隔离，不用再手动切窗口。
              关掉则退回独立窗口（<code>powershell -NoExit</code> / <code>cmd /k claude</code>）。
            </>
          ) : (
            <>
              macOS：用 <code>Terminal.app</code> 开新窗口，<code>cd</code> 到所选目录后（可选注入上面的
              代理命令）起 claude。首次启动时系统会弹「ClaudeDeck 想要控制『终端』」的自动化授权，点允许即可。
            </>
          )}
        </p>
      </div>

      <div className="lc-divider" />
      <WarmupScheduler />
    </div>
  );
}
