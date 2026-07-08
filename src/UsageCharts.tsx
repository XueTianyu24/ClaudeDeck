import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtCost, fmtTokens, shortModel } from "./usageFormat";

/* ---------- 主题色：从 CSS 变量实时解析，随深/浅主题切换重算 ---------- */

const COLOR_VARS = [
  "bg",
  "panel",
  "panel-2",
  "border",
  "text",
  "dim",
  "green",
  "gray",
  "red",
  "amber",
  "blue",
] as const;

type ThemeColors = Record<(typeof COLOR_VARS)[number], string>;

function readColors(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as ThemeColors;
  for (const v of COLOR_VARS) out[v] = cs.getPropertyValue(`--${v}`).trim() || "#888";
  return out;
}

/** 解析当前主题的调色板；监听 data-theme 变化自动重算，让图表跟随深/浅主题。 */
function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(() => readColors());
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(readColors()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);
  return colors;
}

/* ---------- 共用：图表卡片外壳 + 自定义 tooltip ---------- */

function ChartCard({
  title,
  sub,
  children,
  className,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`usage-chart-card ${className ?? ""}`}>
      <div className="usage-chart-head">
        <span className="usage-chart-title">{title}</span>
        {sub && <span className="usage-chart-sub">{sub}</span>}
      </div>
      <div className="usage-chart-body">{children}</div>
    </div>
  );
}

function tooltipBox(colors: ThemeColors): React.CSSProperties {
  return {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12,
    color: colors.text,
    boxShadow: "0 6px 18px rgba(0,0,0,.28)",
    lineHeight: 1.5,
  };
}

/* ---------- 图 1：费用趋势柱状图 ---------- */

type Period = "day" | "week" | "month" | "custom";

type TrendRow = {
  key: string;
  cost: number;
  total_tokens: number;
  message_count: number;
};

/** key 压缩成轴标签：月→"6月"，日/周→"MM-DD"。 */
function compactLabel(key: string, period: Period): string {
  if (period === "month") {
    const m = key.split("-")[1] ?? key;
    return `${Number(m)}月`;
  }
  return key.length >= 10 ? key.slice(5) : key; // YYYY-MM-DD → MM-DD
}

/**
 * 费用趋势柱状图。rows 为「新→旧」排序（与表格一致），内部取最近 N 个并反转为
 * 时间正序（左旧右新），与下方明细表共用同一个 day/week/month 切换。
 */
export function CostTrendChart({
  rows,
  period,
}: {
  rows: TrendRow[];
  period: Period;
}) {
  const colors = useThemeColors();
  const MAX_BARS =
    period === "day" ? 21 : period === "week" ? 16 : period === "month" ? 12 : 92;

  const data = useMemo(
    () =>
      rows
        .slice(0, MAX_BARS)
        .reverse()
        .map((r) => ({
          label: compactLabel(r.key, period),
          cost: Number(r.cost.toFixed(6)),
          tokens: r.total_tokens,
          messages: r.message_count,
        })),
    [rows, period, MAX_BARS],
  );

  if (data.length === 0) {
    return (
      <ChartCard title="费用趋势">
        <div className="usage-chart-empty">无带时间戳的用量记录</div>
      </ChartCard>
    );
  }

  const periodName =
    period === "day" ? "按日" : period === "week" ? "按周" : period === "month" ? "按月" : "按日";
  const sub =
    period === "custom"
      ? `自定义区间 · ${data.length} 天`
      : `${periodName} · 最近 ${data.length} 个周期`;
  const gradId = "cdCostGrad";

  return (
    <ChartCard title="费用趋势" sub={sub} className="usage-chart-trend">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.blue} stopOpacity={0.95} />
              <stop offset="100%" stopColor={colors.blue} stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: colors.dim, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            interval="preserveStartEnd"
            minTickGap={8}
          />
          <YAxis
            tick={{ fill: colors.dim, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={46}
            tickFormatter={(v: number) => (v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`)}
          />
          <Tooltip
            cursor={{ fill: colors.text, fillOpacity: 0.06 }}
            content={(props: any) => {
              if (!props.active || !props.payload?.length) return null;
              const d = props.payload[0].payload;
              return (
                <div style={tooltipBox(colors)}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>{d.label}</div>
                  <div style={{ color: colors.blue }}>费用 {fmtCost(d.cost)}</div>
                  <div style={{ color: colors.dim }}>
                    {fmtTokens(d.tokens)} tokens · {d.messages} 条
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="cost" fill={`url(#${gradId})`} radius={[5, 5, 0, 0]} maxBarSize={42} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/* ---------- 图 2：模型费用占比环形图 ---------- */

type ModelRow = {
  model: string;
  cost: number;
  total_tokens: number;
};

export function ModelCostDonut({ models }: { models: ModelRow[] }) {
  const colors = useThemeColors();

  // 仅画有费用的模型，按费用高→低
  const data = useMemo(
    () =>
      models
        .filter((m) => m.cost > 0)
        .sort((a, b) => b.cost - a.cost)
        .map((m) => ({
          name: shortModel(m.model),
          cost: m.cost,
          tokens: m.total_tokens,
        })),
    [models],
  );

  const palette = useMemo(
    () => [
      colors.blue,
      colors.green,
      colors.amber,
      "#a78bfa",
      colors.red,
      "#22d3ee",
      "#f472b6",
      "#a3e635",
    ],
    [colors],
  );

  const total = useMemo(() => data.reduce((s, d) => s + d.cost, 0), [data]);

  if (data.length === 0) {
    return (
      <ChartCard title="模型费用占比">
        <div className="usage-chart-empty">无可计价模型</div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="模型费用占比" sub={`${data.length} 个模型`} className="usage-chart-donut">
      <div className="usage-donut-wrap">
        <div className="usage-donut-canvas">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="cost"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius="62%"
                outerRadius="92%"
                paddingAngle={data.length > 1 ? 2 : 0}
                stroke={colors.panel}
                strokeWidth={2}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={palette[i % palette.length]} />
                ))}
                <Label
                  position="center"
                  content={(props: any) => {
                    const { cx, cy } = props.viewBox;
                    return (
                      <>
                        <text
                          x={cx}
                          y={cy - 6}
                          textAnchor="middle"
                          fill={colors.text}
                          fontSize={18}
                          fontWeight={700}
                        >
                          {fmtCost(total)}
                        </text>
                        <text
                          x={cx}
                          y={cy + 14}
                          textAnchor="middle"
                          fill={colors.dim}
                          fontSize={11}
                        >
                          总费用
                        </text>
                      </>
                    );
                  }}
                />
              </Pie>
              <Tooltip
                content={(props: any) => {
                  if (!props.active || !props.payload?.length) return null;
                  const d = props.payload[0].payload;
                  const pct = total > 0 ? (d.cost / total) * 100 : 0;
                  return (
                    <div style={tooltipBox(colors)}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{d.name}</div>
                      <div>
                        {fmtCost(d.cost)} · {pct.toFixed(1)}%
                      </div>
                      <div style={{ color: colors.dim }}>{fmtTokens(d.tokens)} tokens</div>
                    </div>
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="usage-donut-legend">
          {data.map((d, i) => {
            const pct = total > 0 ? (d.cost / total) * 100 : 0;
            return (
              <li key={d.name}>
                <span
                  className="usage-donut-dot"
                  style={{ background: palette[i % palette.length] }}
                />
                <span className="usage-donut-name mono" title={d.name}>
                  {d.name}
                </span>
                <span className="usage-donut-cost mono">{fmtCost(d.cost)}</span>
                <span className="usage-donut-pct">{pct.toFixed(0)}%</span>
              </li>
            );
          })}
        </ul>
      </div>
    </ChartCard>
  );
}
