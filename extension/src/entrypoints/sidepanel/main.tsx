import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { parsePopupMode } from "../../lib/popup-mode";
import "./style.css";

// 弹窗模式：sidepanel.html?popup=1&tab=<tabId>&alias=<aliasId?> 以独立窗口运行
// （与侧边栏完全镜像的视图；页面提取钉住原 tab，弹窗聚焦时"活动 tab"是弹窗自己）
const popup = parsePopupMode(window.location.search);

createRoot(document.getElementById("root")!).render(
  <App popupTabId={popup.popup ? popup.tabId : null} popupAliasId={popup.popup ? popup.aliasId : null} />,
);
