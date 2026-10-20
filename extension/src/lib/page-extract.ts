import Defuddle, { createMarkdownContent } from "defuddle/full";
import type { PageSnapshot } from "./attach-policy";

/** 页面提取结果：page 为 null 表示完全失败；error 描述失败或部分失败的原因 */
export interface SnapshotResult {
  page: PageSnapshot | null;
  error: string | null;
}

/**
 * 提取当前活动 tab 的正文（Defuddle→Markdown）与选中文字。
 * 按需注入脚本，不装常驻 content script；DOM 解析在侧栏页面做（SW 无 DOM）。
 * 绝不静默失败：任何一步失败都把可读原因放进 error 返回，由 UI 展示。
 * @returns 提取结果；chrome:// 等不可注入页面 page 为 null 且 error 说明原因
 */
export async function snapshotActiveTab(): Promise<SnapshotResult> {
  let tabId: number;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { page: null, error: "找不到活动标签页" };
    tabId = tab.id;
  } catch (e) {
    return { page: null, error: `查询标签页失败：${errText(e)}` };
  }

  let raw: { html?: string; url: string; title: string; selection: string };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        html: document.documentElement.outerHTML,
        url: location.href,
        title: document.title,
        selection: window.getSelection()?.toString() ?? "",
      }),
    });
    if (!res?.result) return { page: null, error: "注入脚本无返回（可能是特权页面）" };
    raw = res.result as typeof raw;
  } catch (e) {
    // 常见于 chrome:// 特权页，或该页未被 activeTab 授权覆盖
    return { page: null, error: `脚本注入失败：${errText(e)}` };
  }
  if (!raw.html) return { page: null, error: "页面 HTML 为空" };

  let markdown = "";
  let extractErr: string | null = null;
  try {
    const doc = new DOMParser().parseFromString(raw.html, "text/html");
    const parsed = new Defuddle(doc as unknown as Document, { url: raw.url }).parse();
    if (parsed?.content && parsed.content.trim().length > 0) {
      markdown = createMarkdownContent(parsed.content, raw.url).trim();
    }
  } catch (e) {
    extractErr = `正文解析失败：${errText(e)}`;
  }

  if (!markdown) {
    // 回退：非文章型页面（GitHub 列表页、文档目录页等）Defuddle 常返回空 → 退化为页面纯文本
    // 注意 Defuddle.parse 会改动传入的 DOM，所以这里重新解析一份
    try {
      const doc2 = new DOMParser().parseFromString(raw.html, "text/html");
      doc2.querySelectorAll("script,style,noscript,svg").forEach((el) => el.remove());
      const text = (doc2.body?.textContent ?? "")
        .replace(/[ \t\r]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text) {
        markdown = text;
        extractErr = null; // 回退成功即视为提取成功
      }
    } catch (e) {
      extractErr = extractErr ?? `正文解析失败：${errText(e)}`;
    }
    if (!markdown && !extractErr) extractErr = "正文提取结果为空（该页可能不是文章型内容）";
  }
  return { page: { url: raw.url, title: raw.title, markdown, selection: raw.selection }, error: extractErr };
}

/** 把异常对象转成可读文本 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
