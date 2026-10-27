import type { FastModeDisabledReason, FastModeRuntime } from "./protocol";

/**
 * 把 SDK 上报的完整模型 ID 压短显示：claude-fable-5-1 → "fable 5.1"、
 * claude-sonnet-4-5-20250929 → "sonnet 4.5"；不认识的格式（别名、中转自定义 ID）原样返回。
 * @param id 模型 ID 或别名
 * @returns 短名称
 */
export function shortModelName(id: string): string {
  let s = id.replace(/^claude-/, "");
  s = s.replace(/-20\d{6}$/, ""); // 旧版 ID 的日期后缀（如 -20250929）
  s = s.replace(/-(\d+)-(\d+)$/, " $1.$2"); // 结尾版本号横杠转点：fable-5-1 → fable 5.1
  return s;
}

/**
 * 判断链接地址能否在侧栏里作为网页链接打开：仅 http/https 绝对地址。
 * Claude 提到本地文件时常写成 [标准知识.md](标准知识.md) 这类相对链接，
 * 相对 href 会按侧栏页面基地址解析成 chrome-extension://…/sidepanel.html 之类的错误地址，
 * 渲染层据此把这类链接降级为纯文本。
 * @param href markdown 链接的 href（可能为空串）
 * @returns true = 可作为网页链接（新标签打开）；false = 应渲染为纯文本
 */
export function isWebHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** 原生 fast 实际状态的紧凑文案；请求开关值不参与判断。 */
export function fastStatusText(runtime: FastModeRuntime | undefined): string {
  if (!runtime) return "等待 CC 回报";
  if (runtime.state === "on") return "CC fast on";
  if (runtime.state === "off") return "CC fast off";
  return "冷却中（cooldown）";
}

const FAST_DISABLED_REASONS: Record<FastModeDisabledReason, string> = {
  free: "CC 回报：当前账户不包含 fast 权益",
  preference: "CC 回报：偏好设置禁用了 fast",
  extra_usage_disabled: "CC 回报：额外用量已禁用",
  network_error: "CC 回报：网络错误，暂时无法确认 fast",
  unknown: "CC 回报：fast 不可用，原因未知",
  not_first_party: "CC 回报：当前上游未通过第一方检查",
  disabled_by_env: "CC 回报：环境配置禁用了 fast",
  model_not_allowed: "CC 回报：当前模型不允许使用 fast",
  sdk_opt_in_required: "CC 回报：当前 SDK 需要显式启用 fast",
  pending: "CC 回报：正在检查 fast 可用性",
};

/**
 * 把 CC 原生 fast 禁用原因映射为可读提示。
 * @param reason CC init/result 回报的禁用原因
 * @returns 中文说明；不自行推断上游能力或恢复时间
 */
export function fastDisabledReasonText(reason: FastModeDisabledReason): string {
  return FAST_DISABLED_REASONS[reason];
}
