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

/** 页面全文进上下文的最大字符数（超出截断） */
export const MAX_PAGE_CHARS = 30_000;

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

/**
 * 组装发给桥接的最终消息文本（页面全文 + 选中文字 + 用户问题）。
 * @param question 用户输入
 * @param page 页面快照（提取失败为 null）
 * @param attachFull 是否附带全文
 * @returns 最终消息文本
 */
export function composeMessage(question: string, page: PageSnapshot | null, attachFull: boolean): string {
  const parts: string[] = [];
  if (page && attachFull && page.markdown) {
    parts.push(`[页面上下文 url=${page.url} 标题=${page.title}]\n${page.markdown.slice(0, MAX_PAGE_CHARS)}`);
  }
  if (page?.selection) {
    parts.push(`[选中文字]\n${page.selection}`);
  }
  parts.push(`[用户问题]\n${question}`);
  return parts.join("\n\n");
}
