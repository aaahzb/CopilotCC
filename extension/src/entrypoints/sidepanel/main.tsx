import React from "react";
import { createRoot } from "react-dom/client";

/** 占位入口，Task 12 替换为真正的 App */
function Placeholder(): React.ReactElement {
  return <div style={{ padding: 16 }}>Claude Code 侧边栏加载成功</div>;
}

createRoot(document.getElementById("root")!).render(<Placeholder />);
