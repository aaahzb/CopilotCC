import Defuddle, { createMarkdownContent } from "defuddle/full";
import type { PageSnapshot } from "./attach-policy";

/** 页面提取结果：page 为 null 表示完全失败；error 描述失败或部分失败的原因 */
export interface SnapshotResult {
  page: PageSnapshot | null;
  error: string | null;
}

/** Defuddle 结果低于该字符数且不足全文 1/3 时，视为过度精简而改用全文纯文本 */
const MIN_USEFUL_CHARS = 1500;

/**
 * 剥离 HTML 字符串中的 on* 内联事件处理器属性（onclick/onload/onerror 等）。
 * 侧栏/弹窗用 DOMParser 解析页面 HTML 时，解析出的文档继承扩展页 CSP，
 * Chrome 会对每个 on* 属性各报一条 "Executing inline event handler violates CSP" 错误
 * （解析文档 scripting 禁用，处理器不会真正执行，但 chrome://extensions 里会挂红）。
 * 提取正文不需要事件属性（Defuddle 本来也会剔除），故解析前在字符串层剥掉。
 * @param html 原始 HTML 字符串
 * @returns 剥离 on* 属性后的 HTML；双引号/单引号/无引号属性值及等号两侧空白均已处理
 */
export function stripInlineHandlers(html: string): string {
  // 属性值三种写法依次匹配：双引号 / 单引号 / 无引号；i 标志兼容 ONLOAD 等大写写法
  return html.replace(/\son[a-z][a-z0-9-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/**
 * 提取指定 tab 的正文（Defuddle→Markdown）与选中文字。
 * 按需注入脚本，不装常驻 content script；DOM 解析在调用页面内做（SW 无 DOM）。
 * 绝不静默失败：任何一步失败都把可读原因放进 error 返回，由 UI 展示。
 * @param tabId 目标标签页（侧边栏=当前活动 tab；弹窗模式=钉住的 tab——弹窗聚焦时活动 tab 是弹窗自己，必须钉住）
 * @param knownUrl 调用方已知的 tab 地址（如 tabs.query 顺带拿到的）；给了就省一次 tabs.get
 * @returns 提取结果；chrome:// 等不可注入页面、扩展自身页面 page 为 null 且 error 说明原因
 */
export async function snapshotTab(tabId: number, knownUrl?: string): Promise<SnapshotResult> {
  // 扩展自身页面（用户把 sidepanel.html 开成普通标签页，或弹窗模式的弹窗 tab）绝不附带：
  // 否则聊天 UI 的 DOM 和 chrome-extension:// 地址会进入上下文，模型可能把该地址当来源写进产物。
  // 地址获取顺序：调用方已知 → tabs.get 补查；都拿不到不致命（注入后用页面自报的 location.href 再挡一次）
  let tabUrl = knownUrl ?? "";
  if (!tabUrl) {
    try {
      tabUrl = (await chrome.tabs.get(tabId)).url ?? "";
    } catch {
      // 忽略：双保险在注入后
    }
  }
  const ownOrigin = chrome.runtime.getURL(""); // 形如 chrome-extension://<扩展id>/
  if (tabUrl.startsWith(ownOrigin)) {
    return { page: null, error: "目标标签页是本扩展（侧栏/弹窗）自身页面，按设计不附带" };
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
  // 双保险：tabs 拿不到 tab.url 时（权限口径差异），注入后用页面自报的 location.href 再挡一次
  if (raw.url.startsWith(ownOrigin)) {
    return { page: null, error: "目标标签页是本扩展（侧栏/弹窗）自身页面，按设计不附带" };
  }
  if (!raw.html) return { page: null, error: "页面 HTML 为空" };

  // 解析前先剥离 on* 内联事件处理器，避免 DOMParser 继承扩展页 CSP 产生误报（见 stripInlineHandlers）
  const html = stripInlineHandlers(raw.html);

  // Defuddle 正文提取。removeLowScoring: false 保留低评分内容块（课程页/文档页的正文常被误判为低分而删除）
  let markdown = "";
  let extractErr: string | null = null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const parsed = new Defuddle(doc as unknown as Document, { url: raw.url, removeLowScoring: false }).parse();
    if (parsed?.content && parsed.content.trim().length > 0) {
      markdown = createMarkdownContent(parsed.content, raw.url).trim();
    }
  } catch (e) {
    extractErr = `正文解析失败：${errText(e)}`;
  }

  // 全文纯文本：既是 Defuddle 完全失败时的兜底，也是 Defuddle 过度精简时的信息量保障
  const fullText = extractPlainText(html);
  if (!markdown) {
    if (fullText) {
      markdown = fullText;
      extractErr = null; // 回退成功即视为提取成功
    } else if (!extractErr) {
      extractErr = "正文提取结果为空（该页可能不是文章型内容）";
    }
  } else if (markdown.length < MIN_USEFUL_CHARS && fullText.length > markdown.length * 3) {
    // Defuddle 只提到全文的零头 → 宁可用全文（含少量导航噪音）也不让上下文信息过少
    markdown = fullText;
  }
  return { page: { url: raw.url, title: raw.title, markdown, selection: raw.selection }, error: extractErr };
}

/**
 * 提取当前窗口活动 tab 的正文（侧边栏用）。
 * 弹窗模式请用 snapshotTab(钉住 tabId)：弹窗聚焦时活动 tab 是弹窗自己，会被自身守卫拒绝。
 * @returns 提取结果；找不到活动标签页/特权页/扩展自身页面时 page 为 null 且 error 说明原因
 */
export async function snapshotActiveTab(): Promise<SnapshotResult> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { page: null, error: "找不到活动标签页" };
    return await snapshotTab(tab.id, tab.url ?? "");
  } catch (e) {
    return { page: null, error: `查询标签页失败：${errText(e)}` };
  }
}

/**
 * 从完整 HTML 提取页面纯文本：剔除 script/style/noscript/svg 后取 body textContent 并压缩空白。
 * 重新解析一份 DOM（Defuddle.parse 会改动传入的 DOM，不能复用）。
 * @param html 页面完整 HTML（调用方已剥离 on* 内联事件处理器）
 * @returns 纯文本；解析失败返回空串
 */
function extractPlainText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,noscript,svg").forEach((el) => el.remove());
    return (doc.body?.textContent ?? "")
      .replace(/[ \t\r]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}

/** 把异常对象转成可读文本 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
