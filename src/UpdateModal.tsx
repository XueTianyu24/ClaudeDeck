import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "./Markdown";
import { fmtBytes } from "./usageFormat";

// 检查更新（后端 check_for_update 返回）
export type UpdateInfo = {
  current: string;
  latest: string;
  has_update: boolean;
  notes: string;
  url: string;
  published_at: string;
  installer_url: string | null; // Windows -setup.exe 直链；无则只能开下载页
  installer_name: string | null;
  installer_size: number;
};

type DlProgress = {
  downloaded: number;
  total: number;
  done: boolean;
  ok: boolean;
  err: string | null;
};

type Phase = "idle" | "downloading" | "installing" | "error";

// 更新弹窗：发现新版自动弹出。Windows 可一键「下载并安装」（带进度条），
// 下完拉起安装程序并退出本应用；其它平台 / 无安装包资产时退回「打开下载页」。
export default function UpdateModal({
  info,
  onDismiss,
  onLater,
}: {
  info: UpdateInfo;
  onDismiss: () => void; // 忽略此版本（永久，localStorage 记住）
  onLater: () => void; // 稍后（本次会话不再弹）
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prog, setProg] = useState<DlProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const canAutoInstall = !!info.installer_url; // 仅含 -setup.exe 的 Windows release

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    []
  );

  async function startUpdate() {
    if (!info.installer_url || !info.installer_name) {
      openUrl(info.url).catch(() => {});
      return;
    }
    setPhase("downloading");
    setErr(null);
    setProg(null);
    try {
      await invoke("start_update_download", {
        url: info.installer_url,
        fileName: info.installer_name,
        total: info.installer_size,
      });
    } catch (e) {
      setPhase("error");
      setErr(String(e));
      return;
    }
    timer.current = window.setInterval(poll, 250);
  }

  async function poll() {
    try {
      const p = await invoke<DlProgress>("update_download_progress");
      setProg(p);
      if (!p.done) return;
      if (timer.current) window.clearInterval(timer.current);
      if (p.ok) {
        setPhase("installing");
        await invoke("run_update_installer");
        // 给安装程序一点启动时间，再退出本应用让它替换文件、重启新版。
        window.setTimeout(() => invoke("quit_app").catch(() => {}), 1000);
      } else {
        setPhase("error");
        setErr(p.err || "下载失败");
      }
    } catch (e) {
      if (timer.current) window.clearInterval(timer.current);
      setPhase("error");
      setErr(String(e));
    }
  }

  function cancelDownload() {
    if (timer.current) window.clearInterval(timer.current);
    setPhase("idle");
    setProg(null);
  }

  const pct =
    prog && prog.total > 0
      ? Math.min(100, Math.round((prog.downloaded / prog.total) * 100))
      : 0;
  const busy = phase === "downloading" || phase === "installing";

  return (
    <div className="um-overlay">
      <div className="um-modal">
        <div className="um-head">
          <span className="um-emoji">🎉</span>
          <div className="um-headtext">
            <h3 className="um-title">发现新版本 v{info.latest}</h3>
            <p className="um-sub">当前 v{info.current}</p>
          </div>
        </div>

        {info.notes && (
          <div className="um-notes">
            <Markdown>{info.notes}</Markdown>
          </div>
        )}

        {busy ? (
          <div className="um-progress-wrap">
            <div className="um-progress">
              <div
                className="um-progress-fill"
                style={{ width: `${phase === "installing" ? 100 : pct}%` }}
              />
            </div>
            <div className="um-progress-row">
              <span className="um-progress-text">
                {phase === "installing"
                  ? "✅ 下载完成，安装程序已启动，应用即将退出…"
                  : `下载中 ${pct}%${
                      prog
                        ? `（${fmtBytes(prog.downloaded)} / ${fmtBytes(
                            prog.total
                          )}）`
                        : "…"
                    }`}
              </span>
              {phase === "downloading" && (
                <button className="um-btn ghost sm" onClick={cancelDownload}>
                  取消
                </button>
              )}
            </div>
          </div>
        ) : phase === "error" ? (
          <div className="um-errwrap">
            <div className="um-error">❌ {err}</div>
            <div className="um-actions">
              <button
                className="um-btn primary"
                onClick={() => openUrl(info.url).catch(() => {})}
              >
                打开下载页手动安装
              </button>
              <button
                className="um-btn"
                onClick={() => {
                  setPhase("idle");
                  setErr(null);
                }}
              >
                重试
              </button>
              <button className="um-btn ghost" onClick={onLater}>
                关闭
              </button>
            </div>
          </div>
        ) : (
          <div className="um-actions">
            {canAutoInstall ? (
              <button className="um-btn primary" onClick={startUpdate}>
                ⬇ 立即更新（下载并安装）
              </button>
            ) : (
              <button
                className="um-btn primary"
                onClick={() => openUrl(info.url).catch(() => {})}
              >
                打开下载页
              </button>
            )}
            <button className="um-btn" onClick={onLater}>
              稍后
            </button>
            <button className="um-btn ghost" onClick={onDismiss}>
              忽略此版本
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
