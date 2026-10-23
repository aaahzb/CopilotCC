// 后台 service worker：开面板/右键菜单 + 弹窗窗口与页面徽标协调。
// WS 长连接在侧栏/弹窗页面里（SW 30 秒会被回收），本文件只做短命协调：
// 弹窗去重打开/聚焦、钉住上报驱动页面徽标注入、页面导航后徽标重注入、窗口/标签关闭清理。
// SW 回收会丢内存注册表：ccc.popup.open 时扫描现存弹窗 URL 自愈重建；钉住信息由弹窗每次连接后重报。

import { PopupRegistry, type PinInfo } from "../lib/popup-registry";
import { popupUrl } from "../lib/popup-mode";

/** 弹窗默认尺寸（用户可自己再拖） */
const POPUP_WIDTH = 460;
const POPUP_HEIGHT = 720;

/** ccc.* 运行时消息的可选字段集合（结构化校验在分支内做） */
interface CccMessage {
  type?: string;
  tabId?: number;
  aliasId?: string | null;
  winId?: number;
  aliasName?: string;
  hue?: number;
}

export default defineBackground(() => {
  // 点击工具栏图标 → 打开侧边栏
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
    console.warn("[ccc] setPanelBehavior 失败", e);
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "ccc-ask-selection",
      title: "用 CopilotCC 询问选中内容",
      contexts: ["selection"],
    });
  });

  // 右键菜单：选中文字存入 storage.session（侧栏 ready 后主动拉取，避免冷启动 sendMessage 丢失）
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "ccc-ask-selection" || !info.selectionText) return;
    void chrome.storage.session.set({ "ccc.pendingQuote": info.selectionText });
    const winId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    void chrome.sidePanel.open({ windowId: winId });
  });

  const registry = new PopupRegistry();

  chrome.runtime.onMessage.addListener((raw: CccMessage, _sender, sendResponse) => {
    // 只认领 ccc.* 消息（return true 会独占异步应答通道，不能误抢别人的消息）
    if (typeof raw?.type !== "string" || !raw.type.startsWith("ccc.")) return false;
    void handleMessage(raw).then(sendResponse);
    return true;
  });

  /**
   * 弹窗/钉住消息分发。所有分支容错：弹窗主功能不因徽标/窗口 API 失败而挂。
   * @param m 已确认 type 以 ccc. 开头的消息
   * @returns 应答对象（ok 字段表成功与否；open 分支另带 winId/reused）
   */
  async function handleMessage(m: CccMessage): Promise<{ ok: boolean; winId?: number | null; reused?: boolean; error?: string }> {
    switch (m.type) {
      case "ccc.popup.open": {
        const tabId = m.tabId ?? 0;
        if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, error: "缺合法 tabId" };
        await rebuildFromOpenWindows(); // SW 回收后注册表为空，先自愈再去重
        const existing = registry.winForTab(tabId);
        if (existing !== null) {
          try {
            await chrome.windows.update(existing, { focused: true });
            return { ok: true, winId: existing, reused: true };
          } catch {
            // 窗口实际已不在（事件丢失）：继续新开
          }
        }
        const win = await chrome.windows.create({
          url: popupUrl(tabId, m.aliasId),
          type: "popup",
          width: POPUP_WIDTH,
          height: POPUP_HEIGHT,
        });
        if (win?.id != null) registry.registerPopup(win.id, tabId);
        return { ok: win?.id != null, winId: win?.id ?? null, reused: false };
      }
      case "ccc.pin.report": {
        const winId = m.winId ?? 0;
        const tabId = m.tabId ?? 0;
        if (!winId || !tabId) return { ok: false, error: "缺 winId/tabId" };
        const info: PinInfo = { winId, tabId, aliasName: m.aliasName ?? "", hue: m.hue ?? 210 };
        const replaced = registry.pin(info); // 换绑：同一弹窗改钉新页，旧页徽标要摘
        if (replaced !== null) await removeBadge(replaced);
        await injectBadge(info);
        return { ok: true };
      }
      case "ccc.popup.focus": {
        // 页面徽标点击 → 聚焦对应弹窗（窗口没了就静默）
        if (m.winId != null) await chrome.windows.update(m.winId, { focused: true }).catch(() => {});
        return { ok: true };
      }
      default:
        return { ok: false, error: "未知 ccc 消息" };
    }
  }

  /** 扫描现存弹窗窗口重建注册表（SW 被回收重启后内存丢失，靠 URL 参数识别本扩展的弹窗） */
  async function rebuildFromOpenWindows(): Promise<void> {
    try {
      const own = chrome.runtime.getURL("sidepanel.html");
      const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
      for (const w of wins) {
        const url = w.tabs?.[0]?.url ?? "";
        const m = /[?&]tab=(\d+)/.exec(url);
        if (w.id != null && url.startsWith(own) && m) registry.registerPopup(w.id, Number(m[1]));
      }
    } catch {
      // 自愈失败不阻塞新开
    }
  }

  /**
   * 把徽标注入指定页面（失败静默：chrome:// 等不可注入页面徽标缺席，不影响弹窗主功能）。
   * @param info 钉住信息（别名/色相/winId 供徽标渲染与点击聚焦）
   */
  async function injectBadge(info: PinInfo): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: info.tabId },
        func: badgeMain,
        args: [{ aliasName: info.aliasName, hue: info.hue, winId: info.winId }],
      });
    } catch {
      // 不可注入页面：跳过
    }
  }

  /** 摘除指定页面的徽标（页面已关闭时注入会失败，静默） */
  async function removeBadge(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: badgeRemove });
    } catch {
      // 页面已不在：无需摘
    }
  }

  // 页面加载完成 → 徽标重注入（真实导航会清掉 DOM；SPA 推 history 不触发 complete，徽标还在不重注）
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "complete") return;
    const pin = registry.pinForTab(tabId);
    if (pin) void injectBadge(pin);
  });

  // 被钉页面关闭 → 清钉住与登记（徽标随页面消失，无需摘）
  chrome.tabs.onRemoved.addListener((tabId) => {
    registry.tabRemoved(tabId);
  });

  // 弹窗关闭（含"⇱ 回侧边栏"的主动关）→ 摘页面徽标 + 清登记
  chrome.windows.onRemoved.addListener((winId) => {
    const tabId = registry.windowRemoved(winId);
    if (tabId !== null) void removeBadge(tabId);
  });
});

/**
 * 页面徽标渲染（在页面隔离世界执行；chrome 序列化函数体注入，必须自包含：禁止引用任何模块级符号）。
 * 幂等：先删旧徽标再重建，别名/换绑更新直接重调即可。
 * @param args.aliasName 徽标上的别名（空串=未选别名，显通用文案）
 * @param args.hue 徽标底色色相（与别名色一致）
 * @param args.winId 点击徽标要聚焦的弹窗窗口 ID
 */
function badgeMain(args: { aliasName: string; hue: number; winId: number }): void {
  document.getElementById("__ccc_pin_badge__")?.remove();
  const host = document.createElement("div");
  host.id = "__ccc_pin_badge__";
  // 定位样式必须在 light DOM 的 host 上（shadow 内样式管不到 host 自身）
  host.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = [
    "button{display:flex;align-items:center;gap:6px;padding:6px 12px;border:none;border-radius:999px;",
    "font:12px/1.5 -apple-system,'Segoe UI',sans-serif;color:#fff;cursor:pointer;",
    `background:hsl(${args.hue} 60% 42%);box-shadow:0 2px 10px rgba(0,0,0,.4);}`,
    "button:hover{filter:brightness(1.15)}",
    "i{width:8px;height:8px;border-radius:50%;background:#fff;opacity:.9}",
  ].join("");
  const btn = document.createElement("button");
  const dot = document.createElement("i");
  const label = document.createElement("span");
  label.textContent = args.aliasName ? `📌 ${args.aliasName}` : "📌 CopilotCC 弹窗";
  btn.append(dot, label);
  btn.title = "此页面已关联 CopilotCC 弹窗，点击聚焦";
  btn.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "ccc.popup.focus", winId: args.winId });
  });
  shadow.append(style, btn);
  document.documentElement.appendChild(host);
}

/** 摘除页面徽标（与 badgeMain 同样自包含；host id 保持一致） */
function badgeRemove(): void {
  document.getElementById("__ccc_pin_badge__")?.remove();
}
