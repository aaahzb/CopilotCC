import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TerminalClient, type TerminalClientView } from "../../lib/terminal-client";
import { loadSettings } from "../../lib/storage";

const INITIAL_VIEW: TerminalClientView = {
  phase: "connecting",
  message: "正在读取本机连接设置…",
  terminal: null,
  exitCode: null,
};

/**
 * 检查当前可见 xterm 行是否为 Claude Code 的 transcript 视图。
 * @param terminal 真实 xterm 实例
 * @returns 看见 CLI 详细历史及其上下滚动提示时返回 true
 */
function hasVisibleTranscript(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
  let visible = "";
  for (let index = buffer.viewportY; index < end; index += 1) {
    visible += `${buffer.getLine(index)?.translateToString(true) ?? ""}\n`;
  }
  return /Showing detailed transcript/i.test(visible) && visible.includes("↑↓ scroll");
}

/** 独立 Chrome 终端页：xterm 只负责显示与输入，真实进程由桥接 PTY 持有。 */
export default function TerminalApp(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyActiveRef = useRef(false);
  const [view, setView] = useState<TerminalClientView>(INITIAL_VIEW);
  const [hasSelection, setHasSelection] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState("");

  /** 复制当前选区；不读取或显示其他剪贴板内容。 */
  const copySelection = async (): Promise<void> => {
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? "";
    if (!terminal || !selection) return;
    try {
      await navigator.clipboard.writeText(selection);
      setActionMessage("已复制选区");
    } catch {
      setActionMessage("复制失败：请检查浏览器剪贴板权限");
    }
    terminal.focus();
  };

  /** 通过 xterm 粘贴链发送文本，保留 bracketed paste，不写聊天转录。 */
  const pasteClipboard = async (): Promise<void> => {
    const terminal = terminalRef.current;
    if (!terminal || !clientRef.current?.isAttached()) {
      setActionMessage("终端连接后才能粘贴");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      terminal.paste(text);
      setActionMessage("已粘贴到终端");
    } catch {
      setActionMessage("粘贴失败：请检查浏览器剪贴板权限");
    }
    terminal.focus();
  };

  /** 结束一次历史导出等待，清理计时器并显示真实操作结果。 */
  const finishHistory = (message: string): void => {
    historyActiveRef.current = false;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    setHistoryBusy(false);
    setActionMessage(message);
  };

  /** 打开 CLI transcript，确认详细视图后导出到 xterm 原生 scrollback。 */
  const exportScrollback = (): void => {
    const terminal = terminalRef.current;
    const client = clientRef.current;
    if (!terminal || !client?.isAttached()) {
      setActionMessage("终端连接后才能打开历史");
      return;
    }
    if (historyActiveRef.current) return;
    historyActiveRef.current = true;
    setHistoryBusy(true);
    setActionMessage("正在打开 CLI 历史视图…");
    client.input("\x0f"); // Ctrl+O：打开 Claude Code 自带 transcript viewer。
    terminal.focus();
    historyTimerRef.current = setTimeout(() => {
      if (historyActiveRef.current) finishHistory("未检测到历史视图，请手动按 Ctrl+O，再按 [");
    }, 3000);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let pageClosed = false;
    let terminal: Terminal | null = null;
    let client: TerminalClient | null = null;
    let observer: ResizeObserver | null = null;
    const fit = new FitAddon();

    /** 按容器重算尺寸，并只在已 attach 时同步真实 PTY。 */
    const fitAndResize = (): void => {
      if (disposed || pageClosed || !terminal) return;
      fit.fit();
      if (client?.isAttached()) client.resize(terminal.cols, terminal.rows);
    };
    const onPageHide = (): void => {
      if (pageClosed) return;
      pageClosed = true;
      historyActiveRef.current = false;
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
      client?.closePage();
    };
    window.addEventListener("pagehide", onPageHide);

    void loadSettings().then((settings) => {
      // 设置在页面已开始卸载后才返回时，不得再启动 Claude。
      if (disposed || pageClosed) return;
      terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
        fontSize: 14,
        scrollback: 10000,
        theme: { background: "#111318", foreground: "#e8eaed" },
      });
      terminalRef.current = terminal;
      terminal.loadAddon(fit);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(host);
      fit.fit();
      client = new TerminalClient({
        getUrl: () => `ws://${settings.host}:${settings.port}/ws?token=${encodeURIComponent(settings.token)}`,
        write: (data) => terminal?.write(data),
        onView: (next) => { if (!disposed) setView(next); },
        onAttached: fitAndResize,
      });
      clientRef.current = client;
      terminal.onData((data) => client?.input(data));
      terminal.onSelectionChange(() => setHasSelection(terminal?.hasSelection() ?? false));
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const key = event.key.toLowerCase();
        const command = event.ctrlKey || event.metaKey;
        if (command && event.shiftKey && key === "c") {
          event.preventDefault();
          void copySelection();
          return false;
        }
        if (command && event.shiftKey && key === "v") {
          event.preventDefault();
          void pasteClipboard();
          return false;
        }
        if (command && !event.shiftKey && key === "c" && terminal?.hasSelection()) {
          // 有选区时复制；无选区必须继续把 Ctrl+C 交给 PTY 作为中断。
          event.preventDefault();
          void copySelection();
          return false;
        }
        return true;
      });
      terminal.onWriteParsed(() => {
        if (!historyActiveRef.current || !terminal || !hasVisibleTranscript(terminal)) return;
        // `[` 只在 detailed viewer 中是 print to scrollback；普通画面不得盲发。
        if (client?.isAttached()) client.input("[");
        finishHistory(client?.isAttached()
          ? "已发送导出，滚轮可查看"
          : "历史视图已打开，但终端连接已断开");
        terminal.focus();
      });
      observer = new ResizeObserver(fitAndResize);
      observer.observe(host);
      client.connect();
    }).catch(() => {
      if (!disposed) setView({
        phase: "error", message: "无法读取桥接连接设置，未启动 Claude", terminal: null, exitCode: null,
      });
    });

    return () => {
      disposed = true;
      historyActiveRef.current = false;
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
      window.removeEventListener("pagehide", onPageHide);
      observer?.disconnect();
      client?.close();
      clientRef.current = null;
      terminalRef.current = null;
      terminal?.dispose();
    };
  }, []);

  const terminalState = view.terminal;
  const canStop = view.phase === "attached" || view.phase === "reconnecting";
  return (
    <main className="terminal-app">
      <header className="terminal-header">
        <div className="terminal-heading">
          <strong>CopilotCC 终端</strong>
          <span className={`terminal-phase ${view.phase}`} role={view.phase === "error" ? "alert" : "status"}>
            {view.message}{view.exitCode === null ? "" : ` · 退出码 ${view.exitCode}`}
          </span>
        </div>
        <button
          className="terminal-stop"
          disabled={!canStop}
          onClick={() => {
            // 保留 WS 等待真实 exit，不用关窗代替进程结束。
            clientRef.current?.stop();
          }}
        >
          结束终端
        </button>
      </header>
      {terminalState ? (
        <section className="terminal-public-state" aria-label="当前终端会话">
          <span title={terminalState.folder ?? undefined}>{terminalState.folder ?? "等待工作目录"}</span>
          <code>{terminalState.currentSessionId ?? terminalState.initialSessionId ?? "等待 SessionStart"}</code>
          {terminalState.phase === "degraded" ? <span>会话跟随已降级，请查看状态提示</span> : null}
        </section>
      ) : null}
      <section className="terminal-toolbar" aria-label="终端编辑与历史工具">
        <button type="button" disabled={!hasSelection} onClick={() => { void copySelection(); }}>复制</button>
        <button type="button" onClick={() => { void pasteClipboard(); }}>粘贴</button>
        <button type="button" disabled={historyBusy} onClick={exportScrollback}>可滚历史</button>
        <span className="terminal-shortcuts">选区 Ctrl+C 复制 · 无选区 Ctrl+C 中断 · Ctrl+Shift+C/V 复制/粘贴</span>
        {actionMessage ? <span className="terminal-action-status" role="status">{actionMessage}</span> : null}
      </section>
      <div className="terminal-xterm" ref={hostRef} aria-label="Claude Code 终端" />
      <footer className="terminal-footer">“可滚历史”导出后可用滚轮浏览和选择复制；关闭窗口或刷新会结束本次插件终端，聊天记录仍保留。</footer>
    </main>
  );
}
