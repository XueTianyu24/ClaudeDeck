import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import Markdown from "./Markdown";
import { fmtBytes } from "./usageFormat";

// 兜底检查（后端 check_for_update，GitHub API）返回的结构。
// 插件检查失败（latest.json 缺失 / 签名校验失败 / 网络）时用它探测新版，只能「打开下载页」。
export type UpdateInfo = {
  current: string;
  latest: string;
  has_update: boolean;
  notes: string;
  url: string;
  published_at: string;
  installer_url: string | null;
  installer_name: string | null;
  installer_size: number;
};

// 弹窗数据：update 为官方插件的 Update 对象（有 = 可一键下载安装 + 签名验证；
// null = 兜底路径，只能打开下载页手动更新）。
export type UpdateData = {
  current: string;
  latest: string;
  notes: string;
  url: string; // release 页面
  update: Update | null;
};

type Phase = "idle" | "downloading" | "installing" | "restarting" | "error";

const RELEASE_PAGE = "https://github.com/XueTianyu24/ClaudeDeck/releases/latest";

// 更新弹窗：发现新版自动弹出。走官方 tauri-plugin-updater：下载（带进度条 + minisign
// 签名验证）→ 安装 → 自动重启进新版。relaunch 失败时用 force_quit_and_relaunch 兜底
//（游离辅助进程等本进程完全退出再拉起，避开 single-instance 唤回旧窗口的坑）。
export default function UpdateModal({
  data,
  onDismiss,
  onLater,
}: {
  data: UpdateData;
  onDismiss: () => void; // 忽略此版本（永久，localStorage 记住）
  onLater: () => void; // 稍后（本次会话不再弹）
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prog, setProg] = useState<{ downloaded: number; total: number } | null>(
    null
  );
  const [err, setErr] = useState<string | null>(null);

  const canAutoInstall = !!data.update;

  async function startUpdate() {
    const up = data.update;
    if (!up) {
      openUrl(data.url || RELEASE_PAGE).catch(() => {});
      return;
    }
    setPhase("downloading");
    setErr(null);
    setProg(null);
    let total = 0;
    let downloaded = 0;
    let finished = false;
    try {
      await up.download((ev) => {
        // 事件名按小写比较，兼容插件版本间大小写差异（参考实现同款防御）。
        const kind = String((ev as { event?: unknown }).event ?? "").toLowerCase();
        if (kind === "started") {
          total = Number(
            (ev as { data?: { contentLength?: number } }).data?.contentLength ?? 0
          );
          downloaded = 0;
          setProg({ downloaded: 0, total });
        } else if (kind === "progress") {
          const chunk = Number(
            (ev as { data?: { chunkLength?: number } }).data?.chunkLength ?? 0
          );
          if (Number.isFinite(chunk) && chunk > 0) downloaded += chunk;
          setProg({ downloaded, total });
        } else if (kind === "finished") {
          finished = true;
          setProg({ downloaded: total || downloaded, total });
        }
      });
      setPhase("installing");
      await up.install();
      // Windows 下 install() 会拉起安装程序并结束本进程，走不到这里；
      // mac / Linux 继续 relaunch 进新版。
      setPhase("restarting");
      await new Promise((r) => setTimeout(r, 500));
      await relaunch();
    } catch (e) {
      // 下载已完成但 install/relaunch 失败（Tauri v2 已知 mac 问题）：新版其实已落盘，
      // 强退 + 辅助进程重启即可用上；不行再退回手动重启提示。
      const downloadDone = finished || (total > 0 && downloaded >= total);
      if (downloadDone) {
        try {
          await invoke("force_quit_and_relaunch");
          setPhase("restarting");
          return;
        } catch {
          setPhase("error");
          setErr("更新已下载安装，但自动重启失败——请手动重启应用完成更新");
          return;
        }
      }
      setPhase("error");
      setErr(String(e));
    }
  }

  const pct =
    prog && prog.total > 0
      ? Math.min(100, Math.round((prog.downloaded / prog.total) * 100))
      : 0;
  const busy =
    phase === "downloading" || phase === "installing" || phase === "restarting";

  return (
    <div className="um-overlay">
      <div className="um-modal">
        <div className="um-head">
          <span className="um-emoji">🎉</span>
          <div className="um-headtext">
            <h3 className="um-title">发现新版本 v{data.latest}</h3>
            <p className="um-sub">当前 v{data.current}</p>
          </div>
        </div>

        {data.notes && (
          <div className="um-notes">
            <Markdown>{data.notes}</Markdown>
          </div>
        )}

        {busy ? (
          <div className="um-progress-wrap">
            <div className="um-progress">
              <div
                className="um-progress-fill"
                style={{ width: `${phase === "downloading" ? pct : 100}%` }}
              />
            </div>
            <div className="um-progress-row">
              <span className="um-progress-text">
                {phase === "restarting"
                  ? "🔄 更新完成，正在重启进新版…"
                  : phase === "installing"
                  ? "✅ 下载完成（签名已验证），正在安装…"
                  : `下载中 ${pct}%${
                      prog && prog.total > 0
                        ? `（${fmtBytes(prog.downloaded)} / ${fmtBytes(
                            prog.total
                          )}）`
                        : "…"
                    }`}
              </span>
            </div>
          </div>
        ) : phase === "error" ? (
          <div className="um-errwrap">
            <div className="um-error">❌ {err}</div>
            <div className="um-actions">
              <button
                className="um-btn primary"
                onClick={() => openUrl(data.url || RELEASE_PAGE).catch(() => {})}
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
                ⬇ 立即更新（下载并自动安装）
              </button>
            ) : (
              <button
                className="um-btn primary"
                onClick={() => openUrl(data.url || RELEASE_PAGE).catch(() => {})}
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
