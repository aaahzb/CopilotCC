import Defuddle, { createMarkdownContent } from "defuddle/full";
import type { PageSnapshot } from "./attach-policy";

/**
 * 提取当前活动 tab 的正文（Defuddle→Markdown）与选中文字。
 * 按需注入脚本，不装常驻 content script；DOM 解析在侧栏页面做（SW 无 DOM）。
 * @returns 页面快照；chrome:// 等不可注入页面返回 null
 */
export async function snapshotActiveTab(): Promise<PageSnapshot | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        html: document.documentElement.outerHTML,
        url: location.href,
        title: document.title,
        selection: window.getSelection()?.toString() ?? "",
      }),
    });
    const r = res?.result as { html?: string; url: string; title: string; selection: string } | undefined;
    if (!r?.html) return null;
    let markdown = "";
    try {
      const doc = new DOMParser().parseFromString(r.html, "text/html");
      const parsed = new Defuddle(doc as unknown as Document, { url: r.url }).parse();
      if (parsed?.content && parsed.content.trim().length > 0) {
        markdown = createMarkdownContent(parsed.content, r.url).trim();
      }
    } catch {
      // 正文提取失败不致命：仍保留选中文字可用
      markdown = "";
    }
    return { url: r.url, title: r.title, markdown, selection: r.selection };
  } catch {
    return null; // 注入失败（特权页面等），静默降级
  }
}
