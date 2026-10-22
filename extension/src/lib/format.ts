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
