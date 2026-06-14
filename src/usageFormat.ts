// 用量计费视图与图表共用的格式化函数（避免 UsageView ↔ UsageCharts 循环依赖）

/** token 数：>=1M → 1.23M，>=1K → 12.3K，否则原值。 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/** 费用：>=1 两位小数，<1 四位小数（小额也看得清）。 */
export function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** 模型名简写：去 claude- 前缀，opus-4-8 这种留核心。 */
export function shortModel(m: string): string {
  return m.replace(/^claude-/, "");
}
