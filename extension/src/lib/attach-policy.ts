import type { PageRichness } from "./protocol";

/** 页面快照（page-extract 产出） */
export interface PageSnapshot {
  url: string;
  title: string;
  markdown: string;
  selection: string;
}

/** 附带决策结果 */
export interface AttachDecision {
  attachFull: boolean;
  reason: "disabled" | "first" | "url-changed" | "same-url";
}

/** 页面全文进上下文的最大字符数（超出截断）；即标准档上限，各档位见 PAGE_RICHNESS_CAPS */
export const MAX_PAGE_CHARS = 30_000;

/** 页面信息丰富度档位 → 附带全文的最大字符数：精简 5 千（省 token 适合快问）/ 标准 3 万（默认）/ 丰富 10 万（长文求全） */
export const PAGE_RICHNESS_CAPS: Record<PageRichness, number> = { brief: 5_000, standard: 30_000, rich: 100_000 };

/**
 * 按 URL 智能附带决策：首次提问或 URL 变化才带全文；同页后续消息只靠会话上下文。
 * @param lastUrl 本会话上次附带过全文的 URL（从未附带为 null）
 * @param currentUrl 当前页面 URL
 * @param enabled 附带开关
 * @returns 是否附带全文及原因
 */
export function decideAttach(lastUrl: string | null, currentUrl: string, enabled: boolean): AttachDecision {
  if (!enabled) return { attachFull: false, reason: "disabled" };
  if (lastUrl === null) return { attachFull: true, reason: "first" };
  if (lastUrl !== currentUrl) return { attachFull: true, reason: "url-changed" };
  return { attachFull: false, reason: "same-url" };
}

/** 输入已trim；CLI 对开头为 / 的消息按斜杠命令处理，必须保持原文。 */
export function isCliSlashCommand(text: string): boolean {
  return text.startsWith("/");
}

/**
 * 组装发给桥接的最终消息文本（页面全文 + 选中文字 + 用户问题）。
 * @param question 用户输入
 * @param page 页面快照（提取失败为 null）
 * @param attachFull 是否附带全文
 * @param richness 页面信息丰富度（当前别名配置；决定附带全文的截断上限，缺省标准档）
 * @returns 最终消息文本
 */
export function composeMessage(question: string, page: PageSnapshot | null, attachFull: boolean, richness: PageRichness = "standard"): string {
  if (isCliSlashCommand(question)) return question;
  const parts: string[] = [];
  if (page && attachFull && page.markdown) {
    parts.push(`[页面上下文 url=${page.url} 标题=${page.title}]\n${page.markdown.slice(0, PAGE_RICHNESS_CAPS[richness])}`);
  }
  if (page?.selection) {
    parts.push(`[选中文字]\n${page.selection}`);
  }
  parts.push(`[用户问题]\n${question}`);
  return parts.join("\n\n");
}

/**
 * 从实际发送文本反推附带标记（chat.user 广播重放上屏用；优先级与转录解析一致：上传 > 全文 > 选中）。
 * @param sent 实际发送给 Claude 的完整文本（chat.user.sent / 转录 sentText）
 * @returns 附带标记；未附带返回 undefined
 */
export function deriveAttachKind(sent: string): "full" | "selection" | "upload" | undefined {
  if (sent.includes("[上传文件]")) return "upload";
  if (sent.includes("[页面上下文")) return "full";
  if (sent.includes("[选中文字]")) return "selection";
  return undefined;
}
