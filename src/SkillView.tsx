import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Markdown from "./Markdown";

type SkillInfo = {
  name: string;
  title: string | null;
  description: string | null;
  dir: string;
  file_count: number;
  has_references: boolean;
  mtime: number;
  tags: string[];
};
type DocView = { path: string; exists: boolean; content: string; mtime: number };
type SkillFile = { path: string; is_dir: boolean; size: number };

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
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [docMap, setDocMap] = useState<Record<string, DocView>>({});
  const [treeMap, setTreeMap] = useState<Record<string, SkillFile[]>>({});
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  async function reload() {
    try {
      setSkills(await invoke<SkillInfo[]>("list_skills"));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    reload();
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    skills.forEach((s) => s.tags.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [skills]);

  const filtered = useMemo(() => {
    return skills.filter((s) => {
      if (search) {
        const q = search.toLowerCase();
        const hay = `${s.title || ""} ${s.name} ${s.description || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filterTag === UNTAGGED) return s.tags.length === 0;
      if (filterTag) return s.tags.includes(filterTag);
      return true;
    });
  }, [skills, search, filterTag]);

  async function toggle(name: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
    if (!docMap[name]) {
      try {
        const d = await invoke<DocView>("read_skill", { name });
        setDocMap((m) => ({ ...m, [name]: d }));
      } catch {
        /* ignore */
      }
    }
    if (!treeMap[name]) {
      try {
        const t = await invoke<SkillFile[]>("list_skill_files", { name });
        setTreeMap((m) => ({ ...m, [name]: t }));
      } catch {
        /* ignore */
      }
    }
  }

  function startEditTags(s: SkillInfo) {
    setEditingTags(s.name);
    setTagInput(s.tags.join(", "));
  }

  async function openDir(name: string) {
    try {
      await invoke("open_skill_dir", { name });
    } catch (e) {
      setErr(String(e));
    }
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

  if (err) return <div className="banner err">读取技能失败：{err}</div>;
  if (!skills.length)
    return (
      <div className="empty">
        <p>未发现任何技能</p>
        <span>~/.claude/skills/ 下没有带 SKILL.md 的技能目录</span>
      </div>
    );

  return (
    <div className="skill-view">
      <div className="skill-toolbar">
        <input
          className="skill-search"
          placeholder="搜索技能名 / 描述…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="mem-toolbar-hint">
          {filtered.length} / {skills.length} 个技能
        </span>
      </div>

      <div className="skill-filter">
        <button
          className={`skill-chip ${filterTag === null ? "active" : ""}`}
          onClick={() => setFilterTag(null)}
        >
          全部
        </button>
        <button
          className={`skill-chip ${filterTag === UNTAGGED ? "active" : ""}`}
          onClick={() => setFilterTag(UNTAGGED)}
        >
          未标记
        </button>
        {allTags.map((t) => (
          <button
            key={t}
            className={`skill-chip ${filterTag === t ? "active" : ""}`}
            onClick={() => setFilterTag(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="skill-grid">
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
                  <span className="skill-mtime">{fmtAgo(s.mtime)}</span>
                </div>
              </div>
              <div className={`skill-desc ${open ? "full" : ""}`}>
                {s.description || "（无描述）"}
              </div>

              <div className="skill-tags" onClick={(e) => e.stopPropagation()}>
                {s.tags.map((t) => (
                  <span key={t} className="skill-tag">
                    {t}
                  </span>
                ))}
                <button
                  className="skill-tag-edit"
                  onClick={() => startEditTags(s)}
                >
                  🏷 标签
                </button>
                <button
                  className="skill-tag-edit"
                  onClick={() => openDir(s.name)}
                  title="在资源管理器中打开此 skill 目录"
                >
                  📂 打开目录
                </button>
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

              {open && treeMap[s.name] && treeMap[s.name].length > 1 && (
                <div className="skill-tree" onClick={(e) => e.stopPropagation()}>
                  <div className="skill-section-label">📂 文件结构</div>
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
                          {f.is_dir ? "📁" : "📄"} {base}
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
                  <div className="skill-section-label">📄 SKILL.md</div>
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
