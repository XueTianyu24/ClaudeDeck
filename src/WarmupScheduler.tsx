import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// 定时开窗：到点跑 `claude -p` 真正发一条消息，开启 Claude 的 5 小时使用窗口。
// 配置存 %APPDATA%\ClaudeDeck\schedule.json（后端），开机自启由系统管理（autostart 插件）。

type WarmupTrigger = {
  id: string;
  time: string; // "HH:MM"
  days: number[]; // 0=周一 .. 6=周日；空=每天
  enabled: boolean;
};
type ScheduleConfig = {
  enabled: boolean;
  triggers: WarmupTrigger[];
  warmup_prompt: string;
  last_run_ms: number;
  last_run_ok: boolean;
  last_run_msg: string;
};

const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"]; // 0=周一
const WEEKDAYS = [0, 1, 2, 3, 4]; // 工作日

function daysLabel(days: number[]): string {
  if (!days.length) return "每天";
  const set = new Set(days);
  if (days.length === 5 && WEEKDAYS.every((d) => set.has(d))) return "工作日";
  if (days.length === 2 && set.has(5) && set.has(6)) return "周末";
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => "周" + DAY_LABELS[d])
    .join(" ");
}

function fmtTime(ms: number): string {
  if (!ms) return "从未";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export default function WarmupScheduler() {
  const [cfg, setCfg] = useState<ScheduleConfig | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showGuide, setShowGuide] = useState(false); // 官方 Routines 添加教程弹层

  // 新增触发点表单
  const [newTime, setNewTime] = useState("07:00");
  const [newDays, setNewDays] = useState<Set<number>>(
    new Set([0, 1, 2, 3, 4, 5, 6])
  );

  async function reload() {
    try {
      setCfg(await invoke<ScheduleConfig>("schedule_get_config"));
      setAutostart(await invoke<boolean>("schedule_get_autostart"));
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
    window.setTimeout(() => setMsg(null), 2800);
  }

  async function setEnabled(enabled: boolean) {
    try {
      setCfg(await invoke<ScheduleConfig>("schedule_set_enabled", { enabled }));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function setAuto(enabled: boolean) {
    try {
      const on = await invoke<boolean>("schedule_set_autostart", { enabled });
      setAutostart(on);
    } catch (e) {
      setErr(String(e));
    }
  }

  function toggleNewDay(d: number) {
    setNewDays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  async function addTrigger() {
    setErr(null);
    if (newDays.size === 0) {
      setErr("请至少选择一天");
      return;
    }
    // 选满 7 天 → 视为「每天」，发空数组
    const days = newDays.size === 7 ? [] : [...newDays].sort((a, b) => a - b);
    try {
      const c = await invoke<ScheduleConfig>("schedule_add_trigger", {
        time: newTime,
        days,
      });
      setCfg(c);
      flash(`✅ 已添加触发点 ${newTime}`);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function removeTrigger(id: string) {
    try {
      setCfg(await invoke<ScheduleConfig>("schedule_remove_trigger", { id }));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function toggleTrigger(id: string, enabled: boolean) {
    try {
      setCfg(
        await invoke<ScheduleConfig>("schedule_toggle_trigger", { id, enabled })
      );
    } catch (e) {
      setErr(String(e));
    }
  }

  async function runNow() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await invoke<ScheduleConfig>("schedule_run_now");
      setCfg(c);
      flash("✅ 已手动开窗一次");
    } catch (e) {
      setErr("开窗失败：" + String(e));
      reload(); // 拉回 last_run 记录
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) {
    return (
      <div className="ws">
        {err ? (
          <div className="banner err">读取定时配置失败：{err}</div>
        ) : (
          <p className="lc-hint">加载中…</p>
        )}
      </div>
    );
  }

  return (
    <div className="ws">
      <div className="ws-head">
        <div>
          <h3 className="ws-title">⏰ 定时开窗</h3>
          <p className="lc-hint">
            到点自动跑 <code>claude -p</code> 发一条极简消息，开启 Claude 的 5
            小时使用窗口（窗口从第一条消息起算）。按你的作息安排，比如 07:00
            触发就把 7–12 点占成一个工作窗口。
          </p>
        </div>
        <label className="ws-switch" title="总开关">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{cfg.enabled ? "已启用" : "已停用"}</span>
        </label>
      </div>

      {err && <div className="banner err">{err}</div>}
      {msg && <div className="banner ok">{msg}</div>}

      {/* 总开关关着却已配触发点 → 醒目提示，避免「以为开了其实没开」 */}
      {!cfg.enabled && cfg.triggers.length > 0 && (
        <div className="ws-warn">
          ⚠️ 定时已停用，下面的触发点都不会触发。
          <button className="lc-btn" onClick={() => setEnabled(true)}>
            点此启用
          </button>
        </div>
      )}

      {/* 触发点列表 */}
      {cfg.triggers.length === 0 ? (
        <div className="ws-empty">还没有触发点，在下面添加一个</div>
      ) : (
        <ul className="ws-list">
          {cfg.triggers.map((t) => (
            <li key={t.id} className={`ws-row ${t.enabled ? "" : "off"}`}>
              <span className="ws-time">{t.time}</span>
              <span className="ws-days">{daysLabel(t.days)}</span>
              <label className="ws-rowtoggle" title="启用/停用此触发点">
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={(e) => toggleTrigger(t.id, e.target.checked)}
                />
              </label>
              <button
                className="lc-btn"
                onClick={() => removeTrigger(t.id)}
                title="删除"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 新增触发点 */}
      <div className="ws-add">
        <input
          type="time"
          className="ws-timeinput"
          value={newTime}
          onChange={(e) => setNewTime(e.target.value)}
        />
        <div className="ws-daypick">
          {DAY_LABELS.map((lab, d) => (
            <button
              key={d}
              type="button"
              className={`ws-daychip ${newDays.has(d) ? "on" : ""}`}
              onClick={() => toggleNewDay(d)}
            >
              {lab}
            </button>
          ))}
          <button
            type="button"
            className="ws-preset"
            onClick={() => setNewDays(new Set([0, 1, 2, 3, 4, 5, 6]))}
          >
            每天
          </button>
          <button
            type="button"
            className="ws-preset"
            onClick={() => setNewDays(new Set(WEEKDAYS))}
          >
            工作日
          </button>
        </div>
        <button className="lc-btn primary" onClick={addTrigger}>
          + 添加
        </button>
      </div>

      {/* 选项 + 测试 */}
      <div className="ws-opts">
        <label className="lc-check">
          <input
            type="checkbox"
            checked={autostart}
            onChange={(e) => setAuto(e.target.checked)}
          />
          开机自启（启动即隐藏到托盘后台运行）— 定时开窗需要 app 到点在跑，建议开启
        </label>
        <div className="ws-runrow">
          <button className="lc-btn" disabled={busy} onClick={runNow}>
            {busy ? "开窗中…" : "立即开窗一次（测试）"}
          </button>
          <span className={`ws-last ${cfg.last_run_ok ? "ok" : "bad"}`}>
            {cfg.last_run_ms
              ? `上次：${fmtTime(cfg.last_run_ms)} · ${cfg.last_run_msg}`
              : "尚未开过窗"}
          </span>
        </div>
        <p className="lc-hint">
          注意：5 小时窗口锚定「那一窗的第一条消息」。若触发前你已有活跃窗口，这次只会落在旧窗口里、不会顺延；电脑关机时无法触发（物理限制）。开窗会复用启动器里配置的代理命令。
        </p>
      </div>

      {/* 免在线替代方案：官方云端 Routines（实测可独立开窗，见 memory.md 验证记录） */}
      <div className="ws-routines">
        <div className="ws-routines-txt">
          <strong>💡 想免电脑在线？</strong> 官方「Routines」可在 Anthropic
          云端按计划定时开窗，<b>实测会触发账号的 5 小时窗口、全程无需本机运行</b>
          （需 Pro / Max / Team 等订阅并启用 “Claude Code on the web”）。上面的本地定时开窗对所有用户开箱即用，但要求电脑到点在线 —— 按需二选一。
        </div>
        <div className="ws-routines-btns">
          <button className="lc-btn" onClick={() => setShowGuide(true)}>
            📖 添加教程
          </button>
          <button
            className="lc-btn primary"
            onClick={() => openUrl("https://claude.ai/code/routines")}
          >
            前往配置 ↗
          </button>
        </div>
      </div>

      {showGuide && (
        <div className="ws-guide-overlay" onClick={() => setShowGuide(false)}>
          <div className="ws-guide" onClick={(e) => e.stopPropagation()}>
            <div className="ws-guide-head">
              <h3>📖 在官方 Routines 添加「定时开窗」</h3>
              <button
                className="ws-guide-x"
                onClick={() => setShowGuide(false)}
                title="关闭"
              >
                ✕
              </button>
            </div>

            <p className="ws-guide-intro">
              官方 Routines 在 Anthropic 云端按计划开窗，<b>电脑关机也能跑</b>
              （需 Pro / Max / Team 等订阅并启用 “Claude Code on the web”）。下面两种添加方式任选其一。
            </p>

            <div className="ws-guide-sec">
              <h4>方式 A · 网页（最直观）</h4>
              <ol>
                <li>
                  打开 <code>claude.ai/code/routines</code>，点 <b>New routine</b>
                </li>
                <li>
                  起个名 + 写 prompt：
                  <code>只回复 OK，不要使用任何工具或执行任何操作</code>
                  ；prompt 框旁的<b>模型选 Haiku</b>（省额度）
                </li>
                <li>
                  <b>Select repositories</b>：开窗用不到仓库，能跳过就跳过；若表单强制要选，随便挑一个你的仓库即可（prompt 不碰它）
                </li>
                <li>
                  环境用默认 <b>Default</b>
                </li>
                <li>
                  <b>Select a trigger → Schedule → Daily</b>，时间填你要的（如{" "}
                  <code>07:00</code>）——直接本地时间、系统自动转换，<b>不用碰 cron</b>
                </li>
                <li>
                  点 <b>Create</b>
                </li>
              </ol>
            </div>

            <div className="ws-guide-sec">
              <h4>方式 B · CLI（最快，电脑上直接敲）</h4>
              <ol>
                <li>
                  在任意 Claude Code 会话里输入：
                  <br />
                  <code>/schedule 每天早上7点发一条消息只回复OK用来开窗</code>
                </li>
                <li>它会引导你确认时间 / prompt / 保存，跟网页表单一样</li>
                <li>
                  前提：CLI 用 claude.ai 订阅登录（不是 API key），版本 ≥ v2.1.81
                </li>
              </ol>
            </div>

            <p className="ws-guide-tip">
              💡 建好后到点就云端跑、电脑关机也行；想立刻试，在该 Routine 详情页点 <b>Run now</b>。删除 Routine 需在网页操作。
            </p>

            <div className="ws-guide-foot">
              <button
                className="lc-btn primary"
                onClick={() => openUrl("https://claude.ai/code/routines")}
              >
                前往 claude.ai/code/routines ↗
              </button>
              <button className="lc-btn" onClick={() => setShowGuide(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
