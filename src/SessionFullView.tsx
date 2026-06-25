import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const nameMatch = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const argsMatch = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = argsMatch ? argsMatch[1].trim() : "";
    return args ? `⌘ ${name} ${args}` : `⌘ ${name}`;
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

function oneTurnMarkdown(t: Turn): string {
  const out: string[] = [];
  if (t.user) out.push("**🧑 用户**", "", cleanUserText(t.user.text).trim(), "");
  for (const a of t.assistants) out.push("**🤖 Claude**", "", a.text.trim(), "");
  return out.join("\n").trim();
}

function turnsToMarkdown(title: string, turns: Turn[]): string {
  const out: string[] = [`# ${title}`, ""];
  turns.forEach((t, i) => {
    out.push(`## 第 ${i + 1} 轮`, "", oneTurnMarkdown(t), "", "---", "");
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
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
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

  function scrollToTurn(ti: number) {
    const el = bodyRef.current?.querySelector(`[data-ti="${ti}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashTurn(ti);
    window.setTimeout(() => setFlashTurn(null), 1500);
  }

  // 搜索词变化：定位到第一个命中。
  useEffect(() => {
    setCurMatch(0);
    if (matches.length) {
      const id = window.setTimeout(() => scrollToTurn(matches[0]), 60);
      return () => window.clearTimeout(id);
    }
  }, [ql, msgs]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div className="sf-overlay" onClick={onClose}>
      <div className="sf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sf-head">
          <div className="sf-head-row">
            <h3 className="sf-title" title={title}>
              {title}
            </h3>
            <div className="sf-head-actions">
              <button
                className="lc-btn primary"
                onClick={() => flashCopy("all", turnsToMarkdown(title, turns))}
                disabled={!turns.length}
              >
                {copied === "all" ? "✓ 已复制" : "📋 复制整会话"}
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
                        {copied === `t${i}` ? "✓ 已复制" : "📋 复制本轮"}
                      </button>
                    )}
                  </div>
                  {t.user ? (
                    <div className="sf-bubble user">
                      <div className="sf-role">🧑 用户</div>
                      <div className="sf-text">
                        <Markdown>{cleanUserText(t.user.text)}</Markdown>
                      </div>
                    </div>
                  ) : (
                    onlyUser && (
                      <div className="sf-bubble user">
                        <div className="sf-role">（本轮无用户消息）</div>
                      </div>
                    )
                  )}
                  {!onlyUser &&
                    t.assistants.map((a, j) => (
                      <div key={j} className="sf-bubble assistant">
                        <div className="sf-role">🤖 Claude</div>
                        <div className="sf-text">
                          <Markdown>{a.text}</Markdown>
                        </div>
                      </div>
                    ))}
                </div>
              ))}
            </>
          )}
        </div>

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
