// 后台 service worker：只管开面板和右键菜单；WS 长连接在侧栏页面里（SW 30 秒会被回收）

export default defineBackground(() => {
  // 点击工具栏图标 → 打开侧边栏
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
    console.warn("[ccc] setPanelBehavior 失败", e);
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "ccc-ask-selection",
      title: "用 Claude Code 询问选中内容",
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
});
