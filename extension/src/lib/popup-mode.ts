/** 独立窗口（弹窗）模式的 URL 参数解析与构造。弹窗与侧边栏共用同一份 sidepanel.html（镜像视图），靠参数区分角色。 */

/** 弹窗模式参数 */
export interface PopupMode {
  /** 是否弹窗模式（popup=1 且 tab 合法才算；参数残缺一律按侧边栏处理，避免无钉漂浮窗乱截页面） */
  popup: boolean;
  /** 钉住的页面 tabId（弹窗聚焦时"活动 tab"是弹窗自己，页面提取必须钉住原 tab） */
  tabId: number | null;
  /** 打开时要选中的别名；null = 跟随工作区当前别名 */
  aliasId: string | null;
}

/**
 * 解析 sidepanel.html 的 query string。
 * @param search location.search（含前导 ?），如 "?popup=1&tab=42&alias=a1"
 * @returns 弹窗模式参数；popup=1 但 tab 缺失/非正整数时 popup 判 false
 */
export function parsePopupMode(search: string): PopupMode {
  const p = new URLSearchParams(search);
  const rawTab = p.get("tab");
  const tabId = rawTab === null ? NaN : Number(rawTab);
  const validTab = Number.isInteger(tabId) && tabId > 0;
  const alias = p.get("alias");
  return {
    popup: p.get("popup") === "1" && validTab,
    tabId: validTab ? tabId : null,
    aliasId: alias !== null && alias.length > 0 ? alias : null,
  };
}

/**
 * 构造弹窗 URL（扩展相对路径，供 chrome.windows.create）。
 * @param tabId 要钉住的页面 tabId
 * @param aliasId 可选，打开即选中的别名
 * @returns 形如 "sidepanel.html?popup=1&tab=42&alias=a1"
 */
export function popupUrl(tabId: number, aliasId?: string | null): string {
  const q = new URLSearchParams({ popup: "1", tab: String(tabId) });
  if (aliasId) q.set("alias", aliasId);
  return `sidepanel.html?${q.toString()}`;
}
