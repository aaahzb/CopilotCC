import React from "react";
import { createRoot } from "react-dom/client";
import TerminalApp from "./TerminalApp";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

// 独立终端页不使用 StrictMode：开发态重复 effect 会启动两个真实 PTY。
createRoot(document.getElementById("root")!).render(<TerminalApp />);
