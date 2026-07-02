import { useEffect, useMemo, useState } from "react";
import { Globe, Link2, ListOrdered, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "./Markdown";
import ForceGraph, { type GNode, type GEdge } from "./ForceGraph";

type MemoryProject = {
  dir: string;
  label: string;
  count: number;
  has_index: boolean;
};
type MemoryNode = {
  file: string;
  name: string | null;
  description: string | null;
  mem_type: string | null;
  links: string[];
  body: string;
  parse_error: string | null;
  mtime: number;
  raw: string;
};
type DocView = { path: string; exists: boolean; content: string; mtime: number };
type TrashMeta = {
  id: string;
  project: string;
  file: string;
  name: string | null;
  deleted_at: number;
};

// 左栏特殊条目：全局 CLAUDE.md（文档型记忆，非卡片）
const GLOBAL = "__global__";
// editing 取此值时表示在编辑项目 MEMORY.md 索引
const INDEX = "__index__";

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

// 与后端 decode_project_label 一致：取 Desktop- 之后的部分美化显示
function decodeLabel(dir: string) {
  const i = dir.indexOf("Desktop-");
  return i >= 0 ? dir.slice(i + "Desktop-".length) || dir : dir;
}

export default function MemoryView() {
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [globalDoc, setGlobalDoc] = useState<DocView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [graph, setGraph] = useState(false);

  // 编辑 / 删除 / 回收站
  const [editing, setEditing] = useState<string | null>(null); // 文件名，或 GLOBAL
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [trashMode, setTrashMode] = useState(false);
  const [trash, setTrash] = useState<TrashMeta[]>([]);
  const [confirmDel, setConfirmDel] = useState<string | null>(null); // 待确认删除的文件
  const [indexMode, setIndexMode] = useState(false); // 查看当前项目 MEMORY.md
  const [projectDoc, setProjectDoc] = useState<DocView | null>(null);
  const [confirmDirDel, setConfirmDirDel] = useState(false); // 待确认删除空目录

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
    setEditing(null);
    setMsg(null);
    if (sel === GLOBAL) {
      reloadGlobal();
      return;
    }
    setExpanded(new Set());
    setGraph(false);
    setConfirmDel(null);
    setIndexMode(false);
    setConfirmDirDel(false);
    reloadMemories();
  }, [sel]);

  async function reloadMemories() {
    if (sel == null || sel === GLOBAL) return;
    try {
      setMemories(await invoke<MemoryNode[]>("list_memories", { project: sel }));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function reloadGlobal() {
    try {
      setGlobalDoc(await invoke<DocView>("read_global_md"));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function loadTrash() {
    try {
      setTrash(await invoke<TrashMeta[]>("list_trash"));
    } catch (e) {
      setErr(String(e));
    }
  }

  function startEdit(key: string, text: string) {
    setEditing(key);
    setEditText(text);
    setMsg(null);
  }

  async function saveMemoryEdit(node: MemoryNode) {
    setBusy(true);
    setMsg(null);
    try {
      await invoke<number>("save_memory", {
        project: sel,
        file: node.file,
        content: editText,
        expectedMtime: node.mtime,
      });
      await reloadMemories();
      setEditing(null);
      setMsg("✅ 已保存");
    } catch (e) {
      setMsg("❌ " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openIndex() {
    if (sel == null || sel === GLOBAL) return;
    setIndexMode(true);
    setGraph(false);
    setEditing(null);
    setMsg(null);
    try {
      setProjectDoc(await invoke<DocView>("read_project_md", { project: sel }));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function saveProjectIndex() {
    setBusy(true);
    setMsg(null);
    try {
      await invoke<number>("save_project_md", {
        project: sel,
        content: editText,
        expectedMtime: projectDoc?.mtime ?? 0,
      });
      setProjectDoc(await invoke<DocView>("read_project_md", { project: sel }));
      setEditing(null);
      setMsg("✅ 已保存");
    } catch (e) {
      setMsg("❌ " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteEmptyDir() {
    setBusy(true);
    setMsg(null);
    try {
      await invoke("delete_empty_memory_dir", { project: sel });
      const ps = await invoke<MemoryProject[]>("list_memory_projects");
      setProjects(ps);
      setSel(ps.length ? ps[0].dir : GLOBAL);
    } catch (e) {
      setMsg("❌ " + String(e));
    } finally {
      setBusy(false);
      setConfirmDirDel(false);
    }
  }

  async function saveGlobalEdit() {
    setBusy(true);
    setMsg(null);
    try {
      await invoke<number>("save_global_md", {
        content: editText,
        expectedMtime: globalDoc?.mtime ?? 0,
      });
      await reloadGlobal();
      setEditing(null);
      setMsg("✅ 已保存");
    } catch (e) {
      setMsg("❌ " + String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMemory(file: string) {
    setBusy(true);
    setMsg(null);
    try {
      await invoke("delete_memory", { project: sel, file });
      const m = await invoke<MemoryNode[]>("list_memories", { project: sel });
      setMemories(m);
      // 刷新左栏：更新计数，删空的项目（0 条）自动从列表消失
      const ps = await invoke<MemoryProject[]>("list_memory_projects");
      setProjects(ps);
      // 当前项目已删空 → 切到第一个剩余项目，否则回全局
      if (m.length === 0) setSel(ps.length ? ps[0].dir : GLOBAL);
      setMsg("已移入回收站");
    } catch (e) {
      setMsg("❌ " + String(e));
    } finally {
      setBusy(false);
    }
  }

  function openTrash() {
    setTrashMode(true);
    loadTrash();
  }

  async function restoreItem(id: string) {
    try {
      await invoke("restore_trash", { id });
      await loadTrash();
      setProjects(await invoke<MemoryProject[]>("list_memory_projects"));
      await reloadMemories();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function purgeItem(id?: string) {
    const ok =
      typeof confirm === "function"
        ? confirm(id ? "彻底删除这一项？不可恢复。" : "清空回收站？所有项不可恢复。")
        : true;
    if (!ok) return;
    try {
      await invoke("purge_trash", { id: id ?? null });
      await loadTrash();
    } catch (e) {
      setErr(String(e));
    }
  }

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

  // 关系图节点 / 边（排除解析失败项；边两端都须存在）
  const gnodes = useMemo<GNode[]>(
    () =>
      memories
        .filter((m) => !m.parse_error)
        .map((m) => ({
          id: m.file,
          label: m.name || m.file,
          cls: typeMeta(m.mem_type).cls,
        })),
    [memories]
  );

  const gedges = useMemo<GEdge[]>(() => {
    const seen = new Set<string>();
    const out: GEdge[] = [];
    for (const m of memories) {
      if (m.parse_error) continue;
      for (const l of m.links) {
        const t = index.get(l);
        if (!t || t.parse_error || t.file === m.file) continue;
        const key = [m.file, t.file].sort().join("→");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ source: m.file, target: t.file });
      }
    }
    return out;
  }, [memories, index]);

  function focusCard(file: string) {
    setGraph(false);
    setExpanded((s) => new Set(s).add(file));
    setHighlight(file);
    requestAnimationFrame(() => {
      document
        .getElementById("mem-" + file)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => setHighlight((h) => (h === file ? null : h)), 2000);
  }

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

  const curHasIndex = projects.find((p) => p.dir === sel)?.has_index ?? false;

  if (err) return <div className="banner err">读取记忆失败：{err}</div>;

  return (
    <div className="memory-view">
      <aside className="mem-sidebar">
        <button
          className={`mem-proj global ${sel === GLOBAL && !trashMode ? "active" : ""}`}
          onClick={() => {
            setSel(GLOBAL);
            setTrashMode(false);
          }}
          title="~/.claude/CLAUDE.md"
        >
          <span className="mem-proj-label">
            <Globe size={13} /> 全局 CLAUDE.md
          </span>
        </button>
        {projects.length > 0 && <div className="mem-sidebar-sep">项目记忆</div>}
        {projects.map((p) => (
          <button
            key={p.dir}
            className={`mem-proj ${p.dir === sel && !trashMode ? "active" : ""}`}
            onClick={() => {
              setSel(p.dir);
              setTrashMode(false);
            }}
            title={p.dir}
          >
            <span className="mem-proj-label">{p.label}</span>
            <span className="mem-proj-count">{p.count || "空"}</span>
          </button>
        ))}
        <div className="mem-sidebar-sep" />
        <button
          className={`mem-proj ${trashMode ? "active" : ""}`}
          onClick={openTrash}
        >
          <span className="mem-proj-label">
            <Trash2 size={13} /> 回收站
          </span>
        </button>
      </aside>

      <div className="mem-main">
        {trashMode ? (
          <div className="trash-panel">
            <div className="mem-toolbar">
              <span className="mem-toolbar-title">
                <Trash2 size={13} /> 回收站
              </span>
              <span className="mem-toolbar-hint">{trash.length} 项</span>
              {trash.length > 0 && (
                <button
                  className="mem-toolbar-btn danger"
                  onClick={() => purgeItem()}
                >
                  一键清空
                </button>
              )}
            </div>
            {trash.length === 0 ? (
              <div className="empty">
                <p>回收站是空的</p>
              </div>
            ) : (
              <div className="trash-list">
                {trash.map((t) => (
                  <div className="trash-item" key={t.id}>
                    <div className="trash-info">
                      <div className="trash-name">{t.name || t.file}</div>
                      <div className="trash-meta">
                        {decodeLabel(t.project)} · {t.file}
                      </div>
                    </div>
                    <div className="trash-actions">
                      <button
                        className="mem-link-chip"
                        onClick={() => restoreItem(t.id)}
                      >
                        还原
                      </button>
                      <button
                        className="mem-link-chip danger"
                        onClick={() => purgeItem(t.id)}
                      >
                        彻底删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : sel === GLOBAL ? (
          globalDoc == null ? (
            <div className="empty">
              <p>加载中…</p>
            </div>
          ) : !globalDoc.exists ? (
            <div className="empty">
              <p>未找到全局 CLAUDE.md</p>
              <span>~/.claude/CLAUDE.md 不存在</span>
            </div>
          ) : editing === GLOBAL ? (
            <div className="mem-editor">
              <div className="mem-editor-bar">
                <span>编辑 CLAUDE.md（全局，影响所有项目）</span>
                <div className="mem-editor-btns">
                  <button
                    className="mem-toolbar-btn"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    取消
                  </button>
                  <button
                    className="mem-toolbar-btn active"
                    disabled={busy}
                    onClick={saveGlobalEdit}
                  >
                    保存
                  </button>
                </div>
              </div>
              <textarea
                className="mem-textarea"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                spellCheck={false}
              />
              {msg && <p className="phone-msg">{msg}</p>}
            </div>
          ) : (
            <>
              <div className="mem-doc-bar">
                <span className="mem-doc-path">{globalDoc.path}</span>
                <button
                  className="mem-toolbar-btn"
                  onClick={() => startEdit(GLOBAL, globalDoc.content)}
                >
                  编辑
                </button>
              </div>
              {msg && <p className="phone-msg">{msg}</p>}
              <div className="mem-doc">
                <Markdown>{globalDoc.content}</Markdown>
              </div>
            </>
          )
        ) : (
          <>
            <div className="mem-toolbar">
              <button
                className={`mem-toolbar-btn ${!graph && !indexMode ? "active" : ""}`}
                onClick={() => {
                  setGraph(false);
                  setIndexMode(false);
                }}
              >
                卡片
              </button>
              {memories.length > 0 && (
                <button
                  className={`mem-toolbar-btn ${graph ? "active" : ""}`}
                  onClick={() => {
                    setGraph(true);
                    setIndexMode(false);
                  }}
                >
                  关系图
                </button>
              )}
              {curHasIndex && (
                <button
                  className={`mem-toolbar-btn ${indexMode ? "active" : ""}`}
                  onClick={openIndex}
                >
                  <ListOrdered size={12} /> 索引
                </button>
              )}
              <span className="mem-toolbar-hint">
                {gnodes.length} 条记忆 · {gedges.length} 条关联
              </span>
            </div>
            {indexMode ? (
              projectDoc == null ? (
                <div className="empty">
                  <p>加载中…</p>
                </div>
              ) : !projectDoc.exists ? (
                <div className="empty">
                  <p>该项目没有 MEMORY.md 索引</p>
                </div>
              ) : editing === INDEX ? (
                <div className="mem-editor">
                  <div className="mem-editor-bar">
                    <span>编辑 MEMORY.md（项目索引）</span>
                    <div className="mem-editor-btns">
                      <button
                        className="mem-toolbar-btn"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        取消
                      </button>
                      <button
                        className="mem-toolbar-btn active"
                        disabled={busy}
                        onClick={saveProjectIndex}
                      >
                        保存
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="mem-textarea"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    spellCheck={false}
                  />
                  {msg && <p className="phone-msg">{msg}</p>}
                </div>
              ) : (
                <>
                  <div className="mem-doc-bar">
                    <span className="mem-doc-path">{projectDoc.path}</span>
                    <button
                      className="mem-toolbar-btn"
                      onClick={() => startEdit(INDEX, projectDoc.content)}
                    >
                      编辑
                    </button>
                  </div>
                  {msg && <p className="phone-msg">{msg}</p>}
                  <div className="mem-doc">
                    <Markdown>{projectDoc.content}</Markdown>
                  </div>
                </>
              )
            ) : graph ? (
              <ForceGraph
                nodes={gnodes}
                edges={gedges}
                onNodeClick={focusCard}
              />
            ) : memories.length === 0 ? (
              <div className="empty">
                <p>该项目暂无记忆卡片</p>
                {curHasIndex && (
                  <span>仅剩 MEMORY.md 索引（点上方「索引」查看）</span>
                )}
                <div className="empty-actions">
                  {confirmDirDel ? (
                    <>
                      <button
                        className="mem-toolbar-btn danger"
                        disabled={busy}
                        onClick={deleteEmptyDir}
                      >
                        确认：物理删除整个 memory 目录
                      </button>
                      <button
                        className="mem-toolbar-btn"
                        onClick={() => setConfirmDirDel(false)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="mem-toolbar-btn danger"
                      onClick={() => setConfirmDirDel(true)}
                    >
                      <Trash2 size={12} /> 物理删除空目录
                    </button>
                  )}
                </div>
                {msg && <p className="phone-msg">{msg}</p>}
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
                            <div className="mem-card-head">
                              <div className="mem-name">{m.name || m.file}</div>
                              <div
                                className="mem-del"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {confirmDel === m.file ? (
                                  <>
                                    <button
                                      className="mem-del-confirm"
                                      disabled={busy}
                                      onClick={() => {
                                        deleteMemory(m.file);
                                        setConfirmDel(null);
                                      }}
                                    >
                                      确认删除
                                    </button>
                                    <button
                                      className="mem-del-cancel"
                                      onClick={() => setConfirmDel(null)}
                                    >
                                      取消
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="mem-del-btn"
                                    title="删除（移入回收站）"
                                    onClick={() => setConfirmDel(m.file)}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                              </div>
                            </div>
                            {m.description && (
                              <div className="mem-desc">{m.description}</div>
                            )}
                            {open && editing === m.file ? (
                              <div
                                className="mem-editor"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <textarea
                                  className="mem-textarea"
                                  value={editText}
                                  onChange={(e) => setEditText(e.target.value)}
                                  spellCheck={false}
                                />
                                <div className="mem-editor-btns">
                                  <button
                                    className="mem-toolbar-btn"
                                    disabled={busy}
                                    onClick={() => setEditing(null)}
                                  >
                                    取消
                                  </button>
                                  <button
                                    className="mem-toolbar-btn active"
                                    disabled={busy}
                                    onClick={() => saveMemoryEdit(m)}
                                  >
                                    保存
                                  </button>
                                </div>
                                {msg && <p className="phone-msg">{msg}</p>}
                              </div>
                            ) : open ? (
                              <div onClick={(e) => e.stopPropagation()}>
                                {m.body && (
                                  <div className="mem-body">
                                    <Markdown>{m.body}</Markdown>
                                  </div>
                                )}
                                <div className="mem-card-actions">
                                  <button
                                    className="mem-link-chip"
                                    onClick={() => startEdit(m.file, m.raw)}
                                  >
                                    编辑
                                  </button>
                                </div>
                              </div>
                            ) : null}
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
                                      <Link2 size={11} /> {l}
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
          </>
        )}
      </div>
    </div>
  );
}
