const ENGLISH_USAGE_MESSAGES: RendererUsageMessages = Object.freeze({
  usage: "Usage",
  context: "Context",
  recordedCredits: "Recorded usage",
  latestCacheHit: "Latest cache hit (CH)",
  sessionCacheHit: "Average cache hit",
  outputSpeed: "Output speed (TPS)",
  apiOutputSpeed: "API average speed",
  apiOutputSpeedDescription:
    "Output tokens / native API time, including first-token wait; not generation TPS.",
  timeToFirstOutput: "Time to first token (TTFT)",
  cacheRead: "Cache read",
  cacheReadWrite: "Cache read / write",
  cacheHitSummary: "CH",
  sessionGroup: "Session",
  turnGroup: "Latest turn",
  tokensGroup: "Tokens",
  totalTokens: "Total",
  inputOutput: "Input / output",
  sessionCostEstimate: "Cost estimate",
  unpricedModels: "Not priced: ",
  threadUsage: "Thread Usage",
  threadUsageDetails: "Thread Usage details",
  tokensSummary: "tokens",
  tokensPerSecond: "tok/s",
});

const CHINESE_USAGE_MESSAGES: RendererUsageMessages = Object.freeze({
  usage: "用量",
  context: "上下文",
  recordedCredits: "已记录消耗",
  latestCacheHit: "最近缓存命中（CH）",
  sessionCacheHit: "平均缓存命中",
  outputSpeed: "输出速度（TPS）",
  apiOutputSpeed: "API 平均速度",
  apiOutputSpeedDescription: "输出 Token ÷ 原生 API 耗时，含首字等待；不是生成 TPS。",
  timeToFirstOutput: "首 token（TTFT）",
  cacheRead: "缓存读取",
  cacheReadWrite: "缓存读取 / 写入",
  cacheHitSummary: "CH",
  sessionGroup: "会话",
  turnGroup: "本轮",
  tokensGroup: "Token",
  totalTokens: "总数",
  inputOutput: "输入 / 输出",
  sessionCostEstimate: "费用估算",
  unpricedModels: "未计价：",
  threadUsage: "对话用量",
  threadUsageDetails: "对话用量详情",
  tokensSummary: "Token",
  tokensPerSecond: "tok/s",
});

export function rendererUsageMessages(locale: RendererSettingsLocale): RendererUsageMessages {
  return locale === "zh-CN" ? CHINESE_USAGE_MESSAGES : ENGLISH_USAGE_MESSAGES;
}

function decimal(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.?0+$/u, "");
}

export function formatRendererCacheHitRate(value: number): string {
  return `${decimal(value, 1)}%`;
}

/** Cents from one dollar up; below that a third digit keeps small costs from reading $0.00. */
export function formatRendererCost(value: number): string {
  return `$${value.toFixed(Math.abs(value) >= 1 ? 2 : 3)}`;
}

/** A cost that leaves unpriced Models out is a lower bound. */
function formatUsageCost(usage: ThreadUsageSnapshot & { totalCostUsd: number }): string {
  const cost = formatRendererCost(usage.totalCostUsd);
  return usage.unpricedModels?.length ? `≥${cost}` : cost;
}

export function formatRendererCredits(value: number): string {
  return `${value > 0 && value < 0.001 ? "<0.001" : decimal(value, 3)} credits`;
}

export function formatRendererTokenRate(
  value: number,
  locale: RendererSettingsLocale = "en",
): string {
  const rate = value >= 100 ? String(Math.round(value)) : decimal(value, 1);
  return `${rate} ${rendererUsageMessages(locale).tokensPerSecond}`;
}

export function formatRendererLatency(
  milliseconds: number,
  locale: RendererSettingsLocale = "en",
): string {
  const chinese = locale === "zh-CN";
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}${chinese ? " 毫秒" : "ms"}`
    : `${decimal(milliseconds / 1_000, 1)}${chinese ? " 秒" : "s"}`;
}

export function formatRendererTokenCount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1_000) return `${sign}${Math.round(absolute)}`;
  if (absolute < 1_000_000) return `${sign}${decimal(absolute / 1_000, 1)}K`;
  if (absolute < 1_000_000_000) return `${sign}${decimal(absolute / 1_000_000, 1)}M`;
  return `${sign}${decimal(absolute / 1_000_000_000, 1)}B`;
}

export function formatRendererContextSummary(usedTokens: number, windowTokens: number): string {
  return `${decimal((usedTokens / windowTokens) * 100, 1)}% / ${formatRendererTokenCount(windowTokens)}`;
}

