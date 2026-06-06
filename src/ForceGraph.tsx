import { useMemo, useState } from "react";

export type GNode = { id: string; label: string; cls: string };
export type GEdge = { source: string; target: string };

// 虚拟画布坐标系；SVG 用 viewBox 自适应容器宽高
const W = 900;
const H = 600;

/**
 * Fruchterman-Reingold 力导向布局（同步算出静态坐标）。
 * 斥力 k²/d（所有节点对）+ 引力 d²/k（每条边）+ 轻微向心力（防孤立点飞散），
 * 逐步降温收敛。节点规模仅几十，O(n²) 斥力无压力。
 */
function computeLayout(nodes: GNode[], edges: GEdge[]) {
  const n = nodes.length || 1;
  const k = Math.sqrt((W * H) / n) * 0.55;
  const pos = new Map<string, { x: number; y: number }>();
  // 确定性初始分布（圆周），避免随机导致每次布局抖动
  nodes.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2;
    pos.set(nd.id, { x: W / 2 + Math.cos(a) * k, y: H / 2 + Math.sin(a) * k });
  });

  let temp = W / 8;
  for (let it = 0; it < 320; it++) {
    const disp = new Map(nodes.map((nd) => [nd.id, { x: 0, y: 0 }]));

    // 斥力
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i].id)!;
        const b = pos.get(nodes[j].id)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (k * k) / d;
        const di = disp.get(nodes[i].id)!;
        const dj = disp.get(nodes[j].id)!;
        di.x += (dx / d) * f;
        di.y += (dy / d) * f;
        dj.x -= (dx / d) * f;
        dj.y -= (dy / d) * f;
      }
    }

    // 引力（边）
    for (const e of edges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      const ds = disp.get(e.source)!;
      const dt = disp.get(e.target)!;
      ds.x -= (dx / d) * f;
      ds.y -= (dy / d) * f;
      dt.x += (dx / d) * f;
      dt.y += (dy / d) * f;
    }

    // 向心力 + 积分 + 降温
    for (const nd of nodes) {
      const p = pos.get(nd.id)!;
      const dd = disp.get(nd.id)!;
      dd.x += (W / 2 - p.x) * 0.012;
      dd.y += (H / 2 - p.y) * 0.012;
      const d = Math.hypot(dd.x, dd.y) || 0.01;
      p.x += (dd.x / d) * Math.min(d, temp);
      p.y += (dd.y / d) * Math.min(d, temp);
      p.x = Math.max(24, Math.min(W - 24, p.x));
      p.y = Math.max(24, Math.min(H - 24, p.y));
    }
    temp *= 0.97;
  }
  return pos;
}

export default function ForceGraph({
  nodes,
  edges,
  onNodeClick,
}: {
  nodes: GNode[];
  edges: GEdge[];
  onNodeClick: (id: string) => void;
}) {
  const pos = useMemo(() => computeLayout(nodes, edges), [nodes, edges]);
  const [hover, setHover] = useState<string | null>(null);

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    nodes.forEach((n) => m.set(n.id, new Set()));
    edges.forEach((e) => {
      m.get(e.source)?.add(e.target);
      m.get(e.target)?.add(e.source);
    });
    return m;
  }, [nodes, edges]);

  if (!nodes.length)
    return (
      <div className="empty">
        <p>该项目暂无可成图的记忆</p>
      </div>
    );

  const active = (id: string) =>
    !hover || hover === id || (adj.get(hover)?.has(id) ?? false);

  return (
    <div className="fg-wrap">
      <svg
        className="fg-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {edges.map((e, i) => {
          const a = pos.get(e.source);
          const b = pos.get(e.target);
          if (!a || !b) return null;
          const on = !hover || e.source === hover || e.target === hover;
          return (
            <line
              key={i}
              className={`fg-edge ${on ? "on" : ""}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          );
        })}
        {nodes.map((nd) => {
          const p = pos.get(nd.id)!;
          const act = active(nd.id);
          const showLabel =
            hover === nd.id || (hover != null && adj.get(hover)?.has(nd.id));
          const label =
            nd.label.length > 16 ? nd.label.slice(0, 16) + "…" : nd.label;
          return (
            <g
              key={nd.id}
              className={`fg-node ${nd.cls} ${act ? "" : "dim"}`}
              transform={`translate(${p.x},${p.y})`}
              onMouseEnter={() => setHover(nd.id)}
              onMouseLeave={() => setHover((h) => (h === nd.id ? null : h))}
              onClick={() => onNodeClick(nd.id)}
            >
              <circle r={hover === nd.id ? 9 : 6} />
              {showLabel && (
                <text x={11} y={4}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
