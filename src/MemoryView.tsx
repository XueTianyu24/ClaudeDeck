import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "./Markdown";

type MemoryProject = { dir: string; label: string; count: number };
type MemoryNode = {
  file: string;
  name: string | null;
  description: string | null;
  mem_type: string | null;
  links: string[];
  body: string;
  parse_error: string | null;
};
type DocView = { path: string; exists: boolean; content: string };

// 左栏特殊条目：全局 CLAUDE.md（文档型记忆，非卡片）
const GLOBAL = "__global__";

// 四类标准记忆 + 兜底；cls 对应 App.css 里的配色
const TYPE_META: Record<string, { label: string; cls: string }> = {
  user: { label: "用户画像", cls: "t-user" },
  feedback: { label: "反馈偏好", cls: "t-feedback" },
  project: { label: "项目状态", cls: "t-project" },
  reference: { label: "外部参考", cls: "t-reference" },
};
function typeMeta(t: string | null) {
  return (t && TYPE_META[t]) || { label: t || "未分类", cls: "t-other" };
}

const GROUP_ORDER = ["user", "feedback", "project", "reference"];

export default function MemoryView() {
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [globalDoc, setGlobalDoc] = useState<DocView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    invoke<MemoryProject[]>("list_memory_projects")
      .then((ps) => {
        setProjects(ps);
        // 默认选第一个项目；没有项目则落到全局 CLAUDE.md
        setSel(ps.length ? ps[0].dir : GLOBAL);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (sel == null) return;
    if (sel === GLOBAL) {
      invoke<DocView>("read_global_md")
        .then((d) => {
          setGlobalDoc(d);
          setErr(null);
        })
        .catch((e) => setErr(String(e)));
      return;
    }
    invoke<MemoryNode[]>("list_memories", { project: sel })
      .then((m) => {
        setMemories(m);
        setErr(null);
        setExpanded(new Set());
      })
      .catch((e) => setErr(String(e)));
  }, [sel]);

  // 按 type 分组
  const groups = useMemo(() => {
    const g: Record<string, MemoryNode[]> = {};
    for (const m of memories) {
      const k = m.mem_type || "_other";
      (g[k] ||= []).push(m);
    }
    return g;
  }, [memories]);

  const groupKeys = useMemo(
    () =>
      Object.keys(groups).sort((a, b) => {
        const ia = GROUP_ORDER.indexOf(a);
        const ib = GROUP_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      }),
    [groups]
  );

  // [[link]] 解析索引：name / 文件名 / 去掉 .md 都能命中
  const index = useMemo(() => {
    const map = new Map<string, MemoryNode>();
    for (const m of memories) {
      if (m.name) map.set(m.name, m);
      map.set(m.file, m);
      map.set(m.file.replace(/\.md$/, ""), m);
    }
    return map;
  }, [memories]);

  function toggle(file: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(file)) n.delete(file);
      else n.add(file);
      return n;
    });
  }

  function jumpTo(link: string) {
    const t = index.get(link);
    if (!t) return;
    setExpanded((s) => new Set(s).add(t.file));
    setHighlight(t.file);
    requestAnimationFrame(() => {
      document
        .getElementById("mem-" + t.file)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => setHighlight((h) => (h === t.file ? null : h)), 2000);
  }

  if (err) return <div className="banner err">读取记忆失败：{err}</div>;

  return (
    <div className="memory-view">
      <aside className="mem-sidebar">
        <button
          className={`mem-proj global ${sel === GLOBAL ? "active" : ""}`}
          onClick={() => setSel(GLOBAL)}
          title="~/.claude/CLAUDE.md"
        >
          <span className="mem-proj-label">🌐 全局 CLAUDE.md</span>
        </button>
        {projects.length > 0 && <div className="mem-sidebar-sep">项目记忆</div>}
        {projects.map((p) => (
          <button
            key={p.dir}
            className={`mem-proj ${p.dir === sel ? "active" : ""}`}
            onClick={() => setSel(p.dir)}
            title={p.dir}
          >
            <span className="mem-proj-label">{p.label}</span>
            <span className="mem-proj-count">{p.count}</span>
          </button>
        ))}
      </aside>

      <div className="mem-main">
        {sel === GLOBAL ? (
          globalDoc == null ? (
            <div className="empty">
              <p>加载中…</p>
            </div>
          ) : !globalDoc.exists ? (
            <div className="empty">
              <p>未找到全局 CLAUDE.md</p>
              <span>~/.claude/CLAUDE.md 不存在</span>
            </div>
          ) : (
            <>
              <div className="mem-doc-path">{globalDoc.path}</div>
              <div className="mem-doc">
                <Markdown>{globalDoc.content}</Markdown>
              </div>
            </>
          )
        ) : memories.length === 0 ? (
          <div className="empty">
            <p>该项目暂无记忆</p>
          </div>
        ) : (
          groupKeys.map((k) => {
            const meta = typeMeta(k === "_other" ? null : k);
            return (
              <section className="mem-group" key={k}>
                <h3 className={`mem-group-title ${meta.cls}`}>
                  <i className="mem-group-dot" />
                  {meta.label}
                  <span className="mem-group-count">{groups[k].length}</span>
                </h3>
                <div className="mem-grid">
                  {groups[k].map((m) => {
                    const open = expanded.has(m.file);
                    const mt = typeMeta(m.mem_type);
                    return (
                      <div
                        id={"mem-" + m.file}
                        key={m.file}
                        className={`mem-card ${mt.cls} ${
                          highlight === m.file ? "hl" : ""
                        } ${open ? "open" : ""}`}
                        onClick={() => toggle(m.file)}
                      >
                        {m.parse_error ? (
                          <div className="mem-err">
                            ⚠️ {m.file}：{m.parse_error}
                          </div>
                        ) : (
                          <>
                            <div className="mem-name">{m.name || m.file}</div>
                            {m.description && (
                              <div className="mem-desc">{m.description}</div>
                            )}
                            {open && m.body && (
                              <div
                                className="mem-body"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Markdown>{m.body}</Markdown>
                              </div>
                            )}
                            {m.links.length > 0 && (
                              <div
                                className="mem-links"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {m.links.map((l) => {
                                  const ok = index.has(l);
                                  return (
                                    <button
                                      key={l}
                                      className={`mem-link-chip ${ok ? "" : "dead"}`}
                                      disabled={!ok}
                                      onClick={() => jumpTo(l)}
                                      title={ok ? "跳到关联记忆" : "未找到该关联"}
                                    >
                                      🔗 {l}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
