// CodexHost 0.17.4 original usage messages and formatters (MIT); see vendor/codexhost-format.
export const hostFormat=(()=>{
const ENGLISH_USAGE_MESSAGES = Object.freeze({
  usage: "Usage",
  context: "Context",
  recordedCredits: "Recorded usage",
  latestCacheHit: "Latest cache hit (CH)",
  sessionCacheHit: "Average cache hit",
  outputSpeed: "Output speed (TPS)",
  apiOutputSpeed: "API average speed",
  apiOutputSpeedDescription: "Output tokens / native API time, including first-token wait; not generation TPS.",
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
  tokensPerSecond: "tok/s"
});
const CHINESE_USAGE_MESSAGES = Object.freeze({
  usage: "\u7528\u91CF",
  context: "\u4E0A\u4E0B\u6587",
  recordedCredits: "\u5DF2\u8BB0\u5F55\u6D88\u8017",
  latestCacheHit: "\u6700\u8FD1\u7F13\u5B58\u547D\u4E2D\uFF08CH\uFF09",
  sessionCacheHit: "\u5E73\u5747\u7F13\u5B58\u547D\u4E2D",
  outputSpeed: "\u8F93\u51FA\u901F\u5EA6\uFF08TPS\uFF09",
  apiOutputSpeed: "API \u5E73\u5747\u901F\u5EA6",
  apiOutputSpeedDescription: "\u8F93\u51FA Token \xF7 \u539F\u751F API \u8017\u65F6\uFF0C\u542B\u9996\u5B57\u7B49\u5F85\uFF1B\u4E0D\u662F\u751F\u6210 TPS\u3002",
  timeToFirstOutput: "\u9996 token\uFF08TTFT\uFF09",
  cacheRead: "\u7F13\u5B58\u8BFB\u53D6",
  cacheReadWrite: "\u7F13\u5B58\u8BFB\u53D6 / \u5199\u5165",
  cacheHitSummary: "CH",
  sessionGroup: "\u4F1A\u8BDD",
  turnGroup: "\u672C\u8F6E",
  tokensGroup: "Token",
  totalTokens: "\u603B\u6570",
  inputOutput: "\u8F93\u5165 / \u8F93\u51FA",
  sessionCostEstimate: "\u8D39\u7528\u4F30\u7B97",
  unpricedModels: "\u672A\u8BA1\u4EF7\uFF1A",
  threadUsage: "\u5BF9\u8BDD\u7528\u91CF",
  threadUsageDetails: "\u5BF9\u8BDD\u7528\u91CF\u8BE6\u60C5",
  tokensSummary: "Token",
  tokensPerSecond: "tok/s"
});
function rendererUsageMessages(locale) {
  return locale === "zh-CN" ? CHINESE_USAGE_MESSAGES : ENGLISH_USAGE_MESSAGES;
}
function decimal(value, fractionDigits) {
  return value.toFixed(fractionDigits).replace(/\.?0+$/u, "");
}
function formatRendererCacheHitRate(value) {
  return `${decimal(value, 1)}%`;
}
function formatRendererCost(value) {
  return `$${value.toFixed(Math.abs(value) >= 1 ? 2 : 3)}`;
}
function formatUsageCost(usage) {
  const cost = formatRendererCost(usage.totalCostUsd);
  return usage.unpricedModels?.length ? `\u2265${cost}` : cost;
}
function formatRendererCredits(value) {
  return `${value > 0 && value < 1e-3 ? "<0.001" : decimal(value, 3)} credits`;
}
function formatRendererTokenRate(value, locale = "en") {
  const rate = value >= 100 ? String(Math.round(value)) : decimal(value, 1);
  return `${rate} ${rendererUsageMessages(locale).tokensPerSecond}`;
}
function formatRendererLatency(milliseconds, locale = "en") {
  const chinese = locale === "zh-CN";
  return milliseconds < 1e3 ? `${Math.round(milliseconds)}${chinese ? " \u6BEB\u79D2" : "ms"}` : `${decimal(milliseconds / 1e3, 1)}${chinese ? " \u79D2" : "s"}`;
}
function formatRendererTokenCount(value) {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1e3) return `${sign}${Math.round(absolute)}`;
  if (absolute < 1e6) return `${sign}${decimal(absolute / 1e3, 1)}K`;
  if (absolute < 1e9) return `${sign}${decimal(absolute / 1e6, 1)}M`;
  return `${sign}${decimal(absolute / 1e9, 1)}B`;
}
function formatRendererContextSummary(usedTokens, windowTokens) {
  return `${decimal(usedTokens / windowTokens * 100, 1)}% / ${formatRendererTokenCount(windowTokens)}`;
}

return {rendererUsageMessages,formatRendererCost,formatRendererCredits,formatRendererTokenRate,formatRendererLatency,formatRendererTokenCount,formatRendererContextSummary};})();
