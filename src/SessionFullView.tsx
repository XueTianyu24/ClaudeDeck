import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Copy, Download, User } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import Markdown from "./Markdown";

// 会话全文视图：完整展示整个会话，按「用户问 → Claude 答」问答对组织，
// 提供会话内搜索跳转（↑/↓ 定位）+ 滚动到顶/底 + 复制为 Markdown。
// 思路参考 claude-code-history-viewer 的 MessageViewer（虚拟滚动平铺 + 搜索跳转 + 滚动按钮），
// 这里数据量为单会话、用普通滚动即可，不引虚拟化依赖。
// 数据来自后端 read_session_full（只含 user/assistant 真实文本，已跳过工具往返）。

type Msg = { role: string; text: string; timestamp: string | null };
type Turn = { user: Msg | null; assistants: Msg[] };

// 用户提问清洗：调用 skill / 斜杠命令时，jsonl 会把整个 skill 文档展开进用户消息，
// 没必要展示。只保留命令名 + 参数（你实际敲的那句），剥掉注入的 skill 正文。
function cleanUserText(raw: string): string {
  // 斜杠命令：<command-name>/xxx</command-name>（+ 可选 <command-args>）。
  const nameMatch = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const argsMatch = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = argsMatch ? argsMatch[1].trim() : "";
    return args ? `⌘ ${name} ${args}` : `⌘ ${name}`;
  }
  // Skill 工具注入：整份 SKILL.md 作为一条 user 消息注入，以
  // "Base directory for this skill: <路径>" 开头（无 command-name 标签，故上面抓不到）。
  // 只留一行占位、剥掉整份正文，否则「仅用户提问」里会把 skill 全文展开。
  const skillMatch = raw.match(/^Base directory for this skill:\s*(.+)/);
  if (skillMatch) {
    const p = skillMatch[1].trim();
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    return `⌘ skill: ${name}`;
  }
  return raw;
}

// 按 user 消息切分成问答对；开头若是 assistant（少见）归入一个无 user 的轮次。
function groupTurns(msgs: Msg[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of msgs) {
    if (m.role === "user") {
      if (cur) turns.push(cur);
      cur = { user: m, assistants: [] };
    } else {
      if (!cur) cur = { user: null, assistants: [] };
      cur.assistants.push(m);
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// 导出三档：full=全文；foldCode=全留但折叠代码块；brief=每轮 Claude 只留末条 + 折叠代码。
type ExportMode = "full" | "foldCode" | "brief";

// 折叠围栏代码块 ```lang\n...\n``` → `[代码块·N 行]` 占位（大代码块最占 token，另一会话多半不需要）。
function foldCodeBlocks(text: string): string {
  return text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => {
    const lines = body.replace(/\n+$/, "").split("\n").length;
    return `\`[代码块·${lines} 行]\``;
  });
}

// 导出文件名清洗：剥非法字符 + 限长。
function safeFileName(s: string): string {
  return (
    (s || "会话").replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 60).trim() || "会话"
  );
}

function oneTurnMarkdown(t: Turn, mode: ExportMode = "full"): string {
  const out: string[] = [];
  if (t.user) out.push("**🧑 用户**", "", cleanUserText(t.user.text).trim(), "");
  // 精简：每轮 Claude 只留最后一条文本（通常是结论），砍中间过程性文本。
  const assistants = mode === "brief" ? t.assistants.slice(-1) : t.assistants;
  for (const a of assistants) {
    const body = mode === "full" ? a.text.trim() : foldCodeBlocks(a.text).trim();
    out.push("**🤖 Claude**", "", body, "");
  }
  return out.join("\n").trim();
}

function turnsToMarkdown(
  title: string,
  turns: Turn[],
  mode: ExportMode = "full"
): string {
  const out: string[] = [`# ${title}`, ""];
  turns.forEach((t, i) => {
    out.push(`## 第 ${i + 1} 轮`, "", oneTurnMarkdown(t, mode), "", "---", "");
  });
  return out.join("\n");
}

function turnHasMatch(t: Turn, q: string): boolean {
  const hay = [t.user?.text || "", ...t.assistants.map((a) => a.text)]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function SessionFullView({
  file,
  title,
  onClose,
}: {
  file: string;
  title: string;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null); // "all" | `t${i}`
  const [q, setQ] = useState("");
  const [curMatch, setCurMatch] = useState(0); // 当前命中在 matches 里的下标
  const [flashTurn, setFlashTurn] = useState<number | null>(null); // 跳转后高亮的轮次
  const [onlyUser, setOnlyUser] = useState(false); // 仅显示用户提问（快速定位）
  const [exportMode, setExportMode] = useState<ExportMode>("full"); // 导出/复制详略档
  const [curTurn, setCurTurn] = useState(0); // 当前所在轮次（跟随滚动，逐轮导航用）
  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef(0); // 导航游标（逐轮跳转的真实基准，连点也稳，不受滚动动画影响）
  const progRef = useRef(false); // 程序化滚动进行中 → 暂停滚动同步，避免互相打架
  const progTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    navRef.current = 0;
    setCurTurn(0);
    (async () => {
      try {
        const m = await invoke<Msg[]>("read_session_full", { file });
        if (alive) setMsgs(m);
      } catch (e) {
        if (alive) setErr(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  const turns = useMemo(() => (msgs ? groupTurns(msgs) : []), [msgs]);

  const ql = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      ql
        ? turns.reduce<number[]>((acc, t, i) => {
            if (turnHasMatch(t, ql)) acc.push(i);
            return acc;
          }, [])
        : [],
    [turns, ql]
  );

  // 滚动到某轮。align="start" 用于逐轮导航（顶部对齐，跳完顶部就是该轮，连续点才不回弹）；
  // align="center" 用于搜索跳转（命中轮居中、看上下文）。程序化滚动期间置 progRef 暂停滚动同步。
  function scrollToTurn(ti: number, align: ScrollLogicalPosition = "center") {
    const el = bodyRef.current?.querySelector(`[data-ti="${ti}"]`);
    el?.scrollIntoView({ block: align, behavior: "smooth" });
    navRef.current = ti;
    setCurTurn(ti);
    setFlashTurn(ti);
    window.setTimeout(() => setFlashTurn(null), 1500);
    progRef.current = true;
    if (progTimer.current) window.clearTimeout(progTimer.current);
    progTimer.current = window.setTimeout(() => {
      progRef.current = false;
    }, 650);
  }

  // 当前视口顶部所在的轮次：取第一个「底边越过顶部参考线」的轮（顶部那条还没完全滚上去的）。
  // 参考线法对很短的轮次也不误判（避免「顶 ≤ 阈值」把下一短轮也算进来）。
  function currentVisibleTurn(): number {
    const b = bodyRef.current;
    if (!b) return 0;
    const line = b.getBoundingClientRect().top + 8;
    const els = Array.from(b.querySelectorAll<HTMLElement>("[data-ti]"));
    for (const el of els) {
      if (el.getBoundingClientRect().bottom > line) {
        return Number(el.dataset.ti);
      }
    }
    return els.length ? Number(els[els.length - 1].dataset.ti) : 0;
  }

  // 逐轮跳转：基准取导航游标（同步、连点也准），顶部对齐，clamp 到边界。
  function goTurn(delta: number) {
    if (!turns.length) return;
    const next = Math.max(0, Math.min(navRef.current + delta, turns.length - 1));
    scrollToTurn(next, "start");
  }

  // 搜索词变化：定位到第一个命中。
  useEffect(() => {
    setCurMatch(0);
    if (matches.length) {
      const id = window.setTimeout(() => scrollToTurn(matches[0]), 60);
      return () => window.clearTimeout(id);
    }
  }, [ql, msgs]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚动时刷新「当前轮」指示（rAF 节流，passive）。
  useEffect(() => {
    const b = bodyRef.current;
    if (!b || !turns.length) return;
    let raf = 0;
    const onScroll = () => {
      if (progRef.current || raf) return; // 程序化滚动期间不抢游标
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const idx = currentVisibleTurn();
        navRef.current = idx;
        setCurTurn(idx);
      });
    };
    b.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      b.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length, onlyUser]);

  function goMatch(delta: number) {
    if (!matches.length) return;
    const m = (((curMatch + delta) % matches.length) + matches.length) % matches.length;
    setCurMatch(m);
    scrollToTurn(matches[m]);
  }

  function scrollEdge(toBottom: boolean) {
    const b = bodyRef.current;
    if (b) b.scrollTo({ top: toBottom ? b.scrollHeight : 0, behavior: "smooth" });
  }

  async function flashCopy(key: string, text: string) {
    const ok = await copyText(text);
    setCopied(ok ? key : null);
    window.setTimeout(() => setCopied(null), 1800);
  }

  // 按当前档位导出为 .md 文件：dialog 选路径 → 后端写盘。供另一个会话 Read。
  async function doExport() {
    const content = turnsToMarkdown(title, turns, exportMode);
    try {
      const path = await save({
        defaultPath: `${safeFileName(title)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return; // 用户取消
      await invoke("export_session_md", { path, content });
      setCopied("exported");
      window.setTimeout(() => setCopied(null), 1800);
    } catch (e) {
      window.alert("导出失败：" + String(e));
    }
  }

  return (
    <div className="sf-overlay" onClick={onClose}>
      <div className="sf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sf-head">
          <div className="sf-head-row">
            <h3 className="sf-title" title={title}>
              {title}
            </h3>
            <div className="sf-head-actions">
              <select
                className="sf-export-mode"
                value={exportMode}
                onChange={(e) => setExportMode(e.target.value as ExportMode)}
                disabled={!turns.length}
                title="导出 / 复制的详略档位"
              >
                <option value="full">全文</option>
                <option value="foldCode">仅折叠代码</option>
                <option value="brief">精简（每轮留结论）</option>
              </select>
              <button
                className="lc-btn"
                onClick={doExport}
                disabled={!turns.length}
                title="导出为 .md 文件，供另一个会话 Read"
              >
                {copied === "exported" ? (
                  "✓ 已导出"
                ) : (
                  <>
                    <Download size={12} /> 导出 .md
                  </>
                )}
              </button>
              <button
                className="lc-btn primary"
                onClick={() =>
                  flashCopy("all", turnsToMarkdown(title, turns, exportMode))
                }
                disabled={!turns.length}
              >
                {copied === "all" ? (
                  "✓ 已复制"
                ) : (
                  <>
                    <Copy size={12} /> 复制整会话
                  </>
                )}
              </button>
              <button className="sf-x" onClick={onClose} title="关闭">
                ✕
              </button>
            </div>
          </div>
          {turns.length > 0 && (
            <div className="sf-searchrow">
              <div className="sf-modes">
                <button
                  className={!onlyUser ? "active" : ""}
                  onClick={() => setOnlyUser(false)}
                >
                  全部
                </button>
                <button
                  className={onlyUser ? "active" : ""}
                  onClick={() => setOnlyUser(true)}
                >
                  仅用户提问
                </button>
              </div>
              <input
                className="sf-search"
                type="search"
                placeholder="在本会话中查找，回车 / ↓ 跳下一个…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    goMatch(e.shiftKey ? -1 : 1);
                  }
                }}
              />
              {ql && (
                <span className="sf-matchcount">
                  {matches.length ? `${curMatch + 1}/${matches.length}` : "无匹配"}
                </span>
              )}
              <button
                className="sf-nav"
                onClick={() => goMatch(-1)}
                disabled={!matches.length}
                title="上一个匹配 (Shift+Enter)"
              >
                ↑
              </button>
              <button
                className="sf-nav"
                onClick={() => goMatch(1)}
                disabled={!matches.length}
                title="下一个匹配 (Enter)"
              >
                ↓
              </button>
            </div>
          )}
        </div>

        <div className="sf-body" ref={bodyRef}>
          {err ? (
            <p className="sf-msg">读取失败：{err}</p>
          ) : !msgs ? (
            <p className="sf-msg">加载全文中…</p>
          ) : turns.length === 0 ? (
            <p className="sf-msg">没有可显示的对话消息</p>
          ) : (
            <>
              <p className="sf-meta">
                共 {turns.length} 轮问答 · {msgs.length} 条消息
                {onlyUser && " —— 仅看用户提问，点任意一条查看该轮回答"}
              </p>
              {turns.map((t, i) => (
                <div
                  key={i}
                  data-ti={i}
                  className={`sf-turn${flashTurn === i ? " flash" : ""}${
                    onlyUser ? " compact" : ""
                  }`}
                  onClick={
                    onlyUser
                      ? () => {
                          setOnlyUser(false);
                          window.setTimeout(() => scrollToTurn(i), 80);
                        }
                      : undefined
                  }
                  title={onlyUser ? "点击查看该轮完整问答" : undefined}
                >
                  <div className="sf-turn-head">
                    <span className="sf-turn-no">第 {i + 1} 轮</span>
                    {!onlyUser && (
                      <button
                        className="sf-copy"
                        title="复制本轮 Markdown"
                        onClick={(e) => {
                          e.stopPropagation();
                          flashCopy(`t${i}`, oneTurnMarkdown(t));
                        }}
                      >
                        {copied === `t${i}` ? (
                          "✓ 已复制"
                        ) : (
                          <>
                            <Copy size={12} /> 复制本轮
                          </>
                        )}
                      </button>
                    )}
                  </div>
                  {t.user ? (
                    <div className="sf-bubble user">
                      <div className="cd-avatar user"><User size={15} /></div>
                      <div className="sf-bubble-body">
                        <div className="sf-role">用户</div>
                        <div className="sf-text">
                          <Markdown>{cleanUserText(t.user.text)}</Markdown>
                        </div>
                      </div>
                    </div>
                  ) : (
                    onlyUser && (
                      <div className="sf-bubble user">
                        <div className="cd-avatar user"><User size={15} /></div>
                        <div className="sf-bubble-body">
                          <div className="sf-role dim">（本轮无用户消息）</div>
                        </div>
                      </div>
                    )
                  )}
                  {!onlyUser &&
                    t.assistants.map((a, j) => (
                      <div key={j} className="sf-bubble assistant">
                        <div className="cd-avatar assistant"><Bot size={15} /></div>
                        <div className="sf-bubble-body">
                          <div className="sf-role">Claude</div>
                          <div className="sf-text">
                            <Markdown>{a.text}</Markdown>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              ))}
            </>
          )}
        </div>

        {turns.length > 0 && (
          <div className="sf-turnnav">
            <button
              className="sf-turnnav-btn"
              onClick={() => goTurn(-1)}
              disabled={curTurn <= 0}
              title="上一个问答轮"
            >
              ‹ 上一轮
            </button>
            <span className="sf-turnnav-ind">
              第 {curTurn + 1} / {turns.length} 轮
            </span>
            <button
              className="sf-turnnav-btn"
              onClick={() => goTurn(1)}
              disabled={curTurn >= turns.length - 1}
              title="下一个问答轮"
            >
              下一轮 ›
            </button>
          </div>
        )}

        {turns.length > 0 && (
          <div className="sf-scrollbtns">
            <button onClick={() => scrollEdge(false)} title="回到顶部">
              ⇧
            </button>
            <button onClick={() => scrollEdge(true)} title="到底部">
              ⇩
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
