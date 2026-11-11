import type { PopupRegistry } from "./popup-registry";

/** 独立终端窗口打开结果；失败通过异常交给界面显示。 */
export interface TerminalWindowResult {
  ok: boolean;
  winId: number | null;
  reused: boolean;
}

/**
 * 打开或聚焦某个别名的独立终端窗口。
 * 每次先从真实 Chrome 窗口扫描 terminal.html，兼顾 service worker 回收后的内存重建；
 * 只有窗口确实创建成功后才返回，调用方在此之前不会启动 Claude。
 * @param aliasId 当前别名；null 表示未选别名的工作区
 * @param registry 终端与聊天窗口注册表
 * @param api Chrome API；测试可注入窄替身
 * @returns 新建或聚焦结果
 * @throws Chrome 扫描、聚焦或创建 API 的失败由调用方显示
 */
export async function openTerminalWindow(
  aliasId: string | null,
  registry: PopupRegistry,
  api: typeof chrome = chrome,
): Promise<TerminalWindowResult> {
  const key = aliasId ?? "";
  const terminalUrl = api.runtime.getURL("terminal.html");
  try {
    const windows = await api.windows.getAll({ populate: true, windowTypes: ["popup"] });
    for (const win of windows) {
      const url = win.tabs?.[0]?.url ?? "";
      if (win.id == null || !url.startsWith(terminalUrl)) continue;
      const alias = new URL(url).searchParams.get("alias") ?? "";
      registry.registerTerminal(win.id, alias);
    }
  } catch {
    // 自愈扫描失败不阻止直接创建；已有内存映射仍先尝试聚焦。
  }

  const existing = registry.terminalWindowFor(key);
  if (existing !== null) {
    try {
      await api.windows.update(existing, { focused: true });
      return { ok: true, winId: existing, reused: true };
    } catch {
      registry.windowRemoved(existing); // 事件丢失的 stale ID：清除后新建。
    }
  }

  const url = `${terminalUrl}?alias=${encodeURIComponent(key)}`;
  const win = await api.windows.create({ url, type: "popup", width: 1100, height: 720 });
  if (win?.id == null) return { ok: false, winId: null, reused: false };
  registry.registerTerminal(win.id, key);
  return { ok: true, winId: win.id, reused: false };
}
