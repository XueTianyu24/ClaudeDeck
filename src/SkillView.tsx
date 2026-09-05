import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  StickyNote,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { setPref } from "./prefs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Markdown from "./Markdown";

type SkillInfo = {
  name: string;
  title: string | null;
  description: string | null;
  dir: string;
  file_count: number;
  has_references: boolean;
  mtime: number;
  created: number;
  tags: string[];
  note: string | null;
};

type SkillTrashMeta = {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  tags: string[];
  note: string | null;
  deleted_at: number;
};

type SortKey = "name" | "created_desc" | "created_asc";
type DocView = { path: string; exists: boolean; content: string; mtime: number };
type SkillFile = { path: string; is_dir: boolean; size: number };
// 已添加的「查看专属 skill 的项目目录」（后端 skill_projects_list 返回）
type SkillProject = { dir: string; label: string; has_skills: boolean };

const UNTAGGED = "__untagged__";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

export default function SkillView() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  // 作用域：null=个人（~/.claude/skills）；字符串=某项目目录（看其 .claude/skills）
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [projects, setProjects] = useState<SkillProject[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("created_desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [docMap, setDocMap] = useState<Record<string, DocView>>({});
  const [treeMap, setTreeMap] = useState<Record<string, SkillFile[]>>({});
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [trashMode, setTrashMode] = useState(false);
  const [trash, setTrash] = useState<SkillTrashMeta[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">(
    () => (localStorage.getItem("cd-skill-view") as "grid" | "list") || "grid"
  );
  useEffect(() => {
    setPref("cd-skill-view", viewMode); // 真相在后端 ui-prefs.json，见 prefs.ts
  }, [viewMode]);

  // 项目作用域为只读：不做标签 / 备注 / 删除 / 回收站（避免与个人 skill 按名串、
  // 也避免误删别人项目里的文件）。需求是「查看该项目的专属 skill」。
  const readonly = activeProject !== null;

  async function reload() {
    try {
      const list = activeProject
        ? await invoke<SkillInfo[]>("list_project_skills", {
            projectDir: activeProject,
          })
        : await invoke<SkillInfo[]>("list_skills");
      setSkills(list);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  // 载入已添加的项目目录列表（一次）
  useEffect(() => {
    invoke<SkillProject[]>("skill_projects_list").then(setProjects).catch(() => {});
  }, []);

  // 作用域变化（含首次挂载）→ 清缓存 + 拉取该作用域的 skill。docMap/treeMap 按
  // skill 名缓存，个人与项目可能重名，故切换时必须清掉，避免串内容。
  useEffect(() => {
    setExpanded(new Set());
    setDocMap({});
    setTreeMap({});
    setFilterTag(null);
    setEditingTags(null);
    setEditingNote(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  async function addProject() {
    try {
      const dir = await openDialog({
        directory: true,
        title: "选择项目目录（读取其 .claude/skills 下的专属技能）",
      });
      if (!dir || typeof dir !== "string") return;
      const list = await invoke<SkillProject[]>("skill_projects_add", { dir });
      setProjects(list);
      setActiveProject(dir); // 添加后自动切到它
    } catch (e) {
      setErr(String(e));
    }
  }

  async function removeProject(dir: string) {
    try {
      const list = await invoke<SkillProject[]>("skill_projects_remove", { dir });
      setProjects(list);
      if (activeProject === dir) setActiveProject(null);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function loadTrash() {
    try {
      setTrash(await invoke<SkillTrashMeta[]>("list_skill_trash"));
    } catch (e) {
      setErr(String(e));
    }
  }

  // 每个标签下的技能数（含「全部」「未标记」）
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    let untagged = 0;
    skills.forEach((s) => {
      if (s.tags.length === 0) untagged++;
      s.tags.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
    });
    return { map: m, untagged, total: skills.length };
  }, [skills]);

  const allTags = useMemo(
    () => [...tagCounts.map.keys()].sort(),
    [tagCounts]
  );

  const filtered = useMemo(() => {
    const list = skills.filter((s) => {
      if (search) {
        const q = search.toLowerCase();
        const hay = `${s.title || ""} ${s.name} ${s.description || ""} ${
          s.note || ""
        } ${s.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filterTag === UNTAGGED) return s.tags.length === 0;
      if (filterTag) return s.tags.includes(filterTag);
      return true;
    });
    const byName = (a: SkillInfo, b: SkillInfo) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (sortKey === "created_desc")
      list.sort((a, b) => b.created - a.created || byName(a, b));
    else if (sortKey === "created_asc")
      list.sort((a, b) => a.created - b.created || byName(a, b));
    else list.sort(byName);
    return list;
  }, [skills, search, filterTag, sortKey]);

  async function toggle(name: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
    const projectDir = activeProject ?? undefined;
    if (!docMap[name]) {
      try {
        const d = await invoke<DocView>("read_skill", { name, projectDir });
        setDocMap((m) => ({ ...m, [name]: d }));
      } catch {
        /* ignore */
      }
    }
    if (!treeMap[name]) {
      try {
        const t = await invoke<SkillFile[]>("list_skill_files", { name, projectDir });
        setTreeMap((m) => ({ ...m, [name]: t }));
      } catch {
        /* ignore */
      }
    }
  }

  function startEditTags(s: SkillInfo) {
    setEditingNote(null);
    setEditingTags(s.name);
    setTagInput(s.tags.join(", "));
  }

  function startEditNote(s: SkillInfo) {
    setEditingTags(null);
    setEditingNote(s.name);
    setNoteInput(s.note || "");
  }

  async function openDir(name: string) {
    try {
      await invoke("open_skill_dir", { name, projectDir: activeProject ?? undefined });
    } catch (e) {
      setErr(String(e));
    }
  }

  // 一键复制技能名（webview 优先 Clipboard API，失败退回 execCommand）
  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = name;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* ignore */
      }
    }
    setCopied(name);
    window.setTimeout(() => setCopied((c) => (c === name ? null : c)), 1500);
  }

  async function saveTags(name: string) {
    const tags = tagInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await invoke("set_skill_tags", { name, tags });
      setEditingTags(null);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function saveNote(name: string) {
    try {
      await invoke("set_skill_note", { name, note: noteInput.trim() });
      setEditingNote(null);
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function deleteSkill(s: SkillInfo) {
    if (
      !confirm(
        `删除技能「${s.title || s.name}」？\n整个目录将移入回收站，可随时还原。`
      )
    )
      return;
    try {
      await invoke("delete_skill", { name: s.name });
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  function openTrash() {
    setTrashMode(true);
    loadTrash();
  }

  async function restoreItem(id: string) {
    try {
      await invoke("restore_skill_trash", { id });
      await loadTrash();
      await reload();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function purgeItem(id?: string) {
    const ok = confirm(
      id ? "彻底删除这个技能？不可恢复。" : "清空回收站？所有技能不可恢复。"
    );
    if (!ok) return;
    try {
      await invoke("purge_skill_trash", { id: id ?? null });
      await loadTrash();
    } catch (e) {
      setErr(String(e));
    }
  }

  // 作用域切换条：个人 + 已添加项目（可切换 / 移除）+ 添加项目目录
  const scopeBar = (
    <div className="skill-scope">
      <span className="skill-scope-label">技能来源</span>
      <button
        className={`skill-scope-chip ${!activeProject ? "active" : ""}`}
        onClick={() => setActiveProject(null)}
        title="个人技能 ~/.claude/skills"
      >
        <User size={12} /> 个人
      </button>
      {projects.map((p) => (
        <span
          key={p.dir}
          className={`skill-scope-chip proj ${
            activeProject === p.dir ? "active" : ""
          }`}
        >
          <button
            className="skill-scope-pick"
            onClick={() => setActiveProject(p.dir)}
            title={p.has_skills ? p.dir : `${p.dir}\n（未发现 .claude/skills）`}
          >
            {p.label}
            {!p.has_skills && <span className="skill-scope-none">无</span>}
          </button>
          <button
            className="skill-scope-x"
            onClick={() => removeProject(p.dir)}
            title="从列表移除（不会删除项目里的文件）"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <button className="skill-scope-add" onClick={addProject}>
        <FolderPlus size={12} /> 添加项目目录
      </button>
    </div>
  );

  if (err) return <div className="banner err">读取技能失败：{err}</div>;

  if (trashMode) {
    return (
      <div className="skill-view">
        <div className="skill-toolbar">
          <button
            className="mem-toolbar-btn active"
            onClick={() => setTrashMode(false)}
          >
            ← 返回技能列表
          </button>
          <span className="mem-toolbar-title">
            <Trash2 size={13} /> 技能回收站
          </span>
          <span className="mem-toolbar-hint">{trash.length} 项</span>
          {trash.length > 0 && (
            <button className="mem-toolbar-btn" onClick={() => purgeItem()}>
              清空回收站
            </button>
          )}
        </div>
        {trash.length === 0 ? (
          <div className="empty">
            <p>回收站是空的</p>
            <span>删除的技能会移到这里，可随时还原</span>
          </div>
        ) : (
          <div className="trash-list">
            {trash.map((t) => (
              <div className="trash-item" key={t.id}>
                <div className="trash-info">
                  <div className="trash-name">{t.title || t.name}</div>
                  <div className="trash-meta">
                    {t.name}
                    {t.tags.length > 0 && ` · ${t.tags.join(", ")}`} ·{" "}
                    {fmtAgo(t.deleted_at)}删除
                  </div>
                  {t.note && (
                    <div className="skill-note-text">
                      <StickyNote size={12} /> {t.note}
                    </div>
                  )}
                </div>
                <div className="trash-actions">
                  <button
                    className="mem-toolbar-btn active"
                    onClick={() => restoreItem(t.id)}
                  >
                    还原
                  </button>
                  <button
                    className="mem-toolbar-btn"
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
    );
  }

  if (!skills.length)
    return (
      <div className="skill-view">
        {scopeBar}
        {!readonly && (
          <div className="skill-toolbar">
            <button className="mem-toolbar-btn" onClick={openTrash}>
              <Trash2 size={12} /> 回收站
            </button>
          </div>
        )}
        <div className="empty">
          <p>未发现任何技能</p>
          <span>
            {readonly
              ? "该项目 .claude/skills 下没有带 SKILL.md 的技能目录"
              : "~/.claude/skills/ 下没有带 SKILL.md 的技能目录"}
          </span>
        </div>
      </div>
    );

  return (
    <div className="skill-view">
      {scopeBar}
      <div className="skill-toolbar">
        <input
          className="skill-search"
          placeholder={
            readonly ? "搜索技能名 / 描述…" : "搜索技能名 / 描述 / 备注 / 标签…"
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="skill-sort"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          title="排序方式"
        >
          <option value="created_desc">添加日期（新→旧）</option>
          <option value="created_asc">添加日期（旧→新）</option>
          <option value="name">名称 A→Z</option>
        </select>
        <div className="skill-viewtoggle">
          <button
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
            title="网格视图"
          >
            ▦
          </button>
          <button
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
            title="列表视图（技能多时更紧凑）"
          >
            ☰
          </button>
        </div>
        <span className="mem-toolbar-hint">
          {filtered.length} / {skills.length} 个技能
        </span>
        {!readonly && (
          <button className="mem-toolbar-btn" onClick={openTrash}>
            <Trash2 size={12} /> 回收站
          </button>
        )}
      </div>

      {!readonly && (
        <div className="skill-filter">
          <button
            className={`skill-chip ${filterTag === null ? "active" : ""}`}
            onClick={() => setFilterTag(null)}
          >
            全部 <span className="skill-chip-count">{tagCounts.total}</span>
          </button>
          <button
            className={`skill-chip ${filterTag === UNTAGGED ? "active" : ""}`}
            onClick={() => setFilterTag(UNTAGGED)}
          >
            未标记 <span className="skill-chip-count">{tagCounts.untagged}</span>
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              className={`skill-chip ${filterTag === t ? "active" : ""}`}
              onClick={() => setFilterTag(t)}
            >
              {t}{" "}
              <span className="skill-chip-count">{tagCounts.map.get(t) || 0}</span>
            </button>
          ))}
        </div>
      )}

      <div className={viewMode === "list" ? "skill-list" : "skill-grid"}>
        {filtered.map((s) => {
          const open = expanded.has(s.name);
          return (
            <div
              key={s.name}
              className={`skill-card ${open ? "open" : ""}`}
              onClick={() => toggle(s.name)}
            >
              <div className="skill-card-head">
                <div className="skill-name">{s.title || s.name}</div>
                <div className="skill-head-right">
                  {s.has_references && (
                    <span className="skill-badge" title="含 references 子目录">
                      📁 references
                    </span>
                  )}
                  <span
                    className="skill-mtime"
                    title={`添加于 ${fmtAgo(s.created)}　最近修改 ${fmtAgo(
                      s.mtime
                    )}`}
                  >
                    {fmtAgo(s.created)}添加
                  </span>
                </div>
              </div>
              <div className={`skill-desc ${open ? "full" : ""}`}>
                {s.description || "（无描述）"}
              </div>

              {s.note && editingNote !== s.name && (
                <div
                  className="skill-note-text"
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditNote(s);
                  }}
                  title="点击编辑备注"
                >
                  <StickyNote size={12} /> {s.note}
                </div>
              )}

              <div className="skill-tags" onClick={(e) => e.stopPropagation()}>
                {s.tags.map((t) => (
                  <span key={t} className="skill-tag">
                    {t}
                  </span>
                ))}
                <button
                  className="skill-tag-edit"
                  onClick={() => copyName(s.name)}
                  title={`复制技能名：${s.name}`}
                >
                  {copied === s.name ? (
                    "✓ 已复制"
                  ) : (
                    <>
                      <Copy size={11} /> 复制名
                    </>
                  )}
                </button>
                {!readonly && (
                  <>
                    <button
                      className="skill-tag-edit"
                      onClick={() => startEditTags(s)}
                    >
                      <Tag size={11} /> 标签
                    </button>
                    <button
                      className="skill-tag-edit"
                      onClick={() => startEditNote(s)}
                    >
                      <StickyNote size={11} /> 备注
                    </button>
                  </>
                )}
                <button
                  className="skill-tag-edit"
                  onClick={() => openDir(s.name)}
                  title="在文件管理器中打开此 skill 目录"
                >
                  <FolderOpen size={11} /> 打开目录
                </button>
                {!readonly && (
                  <button
                    className="skill-tag-edit danger"
                    onClick={() => deleteSkill(s)}
                    title="删除此技能（移入回收站）"
                  >
                    <Trash2 size={11} /> 删除
                  </button>
                )}
              </div>

              {editingTags === s.name && (
                <div
                  className="skill-tag-editor"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    className="skill-search"
                    placeholder="逗号分隔，如：绘图, 文档"
                    value={tagInput}
                    autoFocus
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveTags(s.name);
                    }}
                  />
                  <button
                    className="mem-toolbar-btn active"
                    onClick={() => saveTags(s.name)}
                  >
                    保存
                  </button>
                  <button
                    className="mem-toolbar-btn"
                    onClick={() => setEditingTags(null)}
                  >
                    取消
                  </button>
                </div>
              )}

              {editingNote === s.name && (
                <div
                  className="skill-tag-editor"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    className="skill-search"
                    placeholder="给这个技能写点备注，方便以后查找…"
                    value={noteInput}
                    autoFocus
                    onChange={(e) => setNoteInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveNote(s.name);
                    }}
                  />
                  <button
                    className="mem-toolbar-btn active"
                    onClick={() => saveNote(s.name)}
                  >
                    保存
                  </button>
                  <button
                    className="mem-toolbar-btn"
                    onClick={() => setEditingNote(null)}
                  >
                    取消
                  </button>
                </div>
              )}

              {open && treeMap[s.name] && treeMap[s.name].length > 1 && (
                <div className="skill-tree" onClick={(e) => e.stopPropagation()}>
                  <div className="skill-section-label">
                    <FolderOpen size={12} /> 文件结构
                  </div>
                  {treeMap[s.name].map((f) => {
                    const depth = f.path.split("/").length - 1;
                    const base = f.path.split("/").pop() || f.path;
                    return (
                      <div
                        key={f.path}
                        className="skill-tree-row"
                        style={{ paddingLeft: 8 + depth * 18 }}
                      >
                        <span>
                          {f.is_dir ? (
                            <Folder size={12} />
                          ) : (
                            <FileText size={12} />
                          )}{" "}
                          {base}
                        </span>
                        {!f.is_dir && (
                          <span className="skill-tree-size">
                            {fmtSize(f.size)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {open && docMap[s.name]?.exists && (
                <div className="skill-body" onClick={(e) => e.stopPropagation()}>
                  <div className="skill-section-label">
                    <FileText size={12} /> SKILL.md
                  </div>
                  <Markdown>{docMap[s.name].content}</Markdown>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
