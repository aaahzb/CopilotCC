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

/** 自动导出失败后的冷却时间：避免用户继续滚轮时反复向 CLI 发送 Ctrl+O。 */
const AUTO_HISTORY_COOLDOWN_MS = 8000;

/** 滚轮触发导出后，轮询等待 transcript 落进 scrollback 的间隔。 */
const HISTORY_SCROLL_DELAY_MS = 600;

/** 滚轮触发导出后等待 transcript 写入 scrollback 的总预算；超时放弃自动翻页。 */
const HISTORY_SCROLL_WAIT_MS = 3000;

/**
 * 检查当前可见 xterm 行是否为 Claude Code 的 transcript 视图。
 * 页脚稳定段是 “Showing detailed transcript · ctrl+o to toggle”；“↑↓ scroll”只在
 * virtualScroll 为真且窗口够宽时出现，不能作为判定条件，否则窄窗口必然误报未打开。
 * @param terminal 真实 xterm 实例
 * @returns 看见 CLI 详细历史及其 ctrl+o 切换提示时返回 true
 */
function hasVisibleTranscript(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  const end = Math.min(buffer.length, buffer.viewportY + terminal.rows);
  let visible = "";
  for (let index = buffer.viewportY; index < end; index += 1) {
    visible += `${buffer.getLine(index)?.translateToString(true) ?? ""}\n`;
  }
  return /Showing detailed transcript/i.test(visible) && /to toggle/i.test(visible);
}

/** 独立 Chrome 终端页：xterm 只负责显示与输入，真实进程由桥接 PTY 持有。 */
export default function TerminalApp(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyActiveRef = useRef(false);
  const historyFailedAtRef = useRef(0);
  const historyScrollAfterExportRef = useRef(false);
  const historyScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /**
   * 结束一次历史导出等待，清理计时器并显示真实操作结果。
   * @param message 显示给用户的结果文案
   * @param exported 是否已真实向 CLI 发送导出键 `[`；失败时记录冷却时间
   */
  const finishHistory = (message: string, exported = false): void => {
    historyActiveRef.current = false;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    setHistoryBusy(false);
    setActionMessage(message);
    if (!exported) {
      // 未看到 transcript 就结束：短时间内的滚轮不再重复发送 Ctrl+O。
      historyFailedAtRef.current = Date.now();
      historyScrollAfterExportRef.current = false;
      return;
    }
    historyFailedAtRef.current = 0;
    if (!historyScrollAfterExportRef.current) return;
    historyScrollAfterExportRef.current = false;
    // 滚轮触发的导出要在 transcript 真正落进 scrollback 后向上翻一页，让第一次滚轮就有
    // 可见反馈；手动点「可滚历史」不改变用户当前视口。CLI 打印耗时不定，这里短轮询
    // 等待 baseY 增长，超过预算仍未增长就放弃，不阻塞任何交互。
    if (historyScrollTimerRef.current) clearTimeout(historyScrollTimerRef.current);
    const deadline = Date.now() + HISTORY_SCROLL_WAIT_MS;
    const scrollWhenHistoryReady = (): void => {
      const terminal = terminalRef.current;
      if (!terminal) {
        historyScrollTimerRef.current = null;
        return;
      }
      if (terminal.buffer.active.baseY > 0) {
        historyScrollTimerRef.current = null;
        terminal.scrollPages(-1);
        return;
      }
      if (Date.now() >= deadline) {
        historyScrollTimerRef.current = null;
        return;
      }
      historyScrollTimerRef.current = setTimeout(scrollWhenHistoryReady, HISTORY_SCROLL_DELAY_MS);
    };
    historyScrollTimerRef.current = setTimeout(scrollWhenHistoryReady, HISTORY_SCROLL_DELAY_MS);
  };

  /**
   * 打开 CLI transcript，确认详细视图后导出到 xterm 原生 scrollback。
   * @param fromWheel 是否由向上滚轮触发；为 true 时导出成功后自动向上翻一页
   */
  const exportScrollback = (fromWheel = false): void => {
    const terminal = terminalRef.current;
    const client = clientRef.current;
    if (!terminal || !client?.isAttached()) {
      setActionMessage("终端连接后才能打开历史");
      return;
    }
    if (historyActiveRef.current) return;
    historyActiveRef.current = true;
    historyScrollAfterExportRef.current = fromWheel;
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
      historyScrollAfterExportRef.current = false;
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
      if (historyScrollTimerRef.current) clearTimeout(historyScrollTimerRef.current);
      historyScrollTimerRef.current = null;
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
      terminal.attachCustomWheelEventHandler((event) => {
        const buffer = terminal?.buffer.active;
        // 普通画面上滚、且视口上方没有任何原生历史（baseY 为 0）时 xterm 无处可滚：
        // Claude Code 原地重绘不会把完整历史留在 scrollback。这里自动执行与「可滚历史」
        // 按钮相同的导出，用户不必先点按钮。alternate 缓冲区（CLI 自带详细历史视图）
        // 必须交回 xterm 转成方向键，不能抢占。
        if (event.deltaY < 0 && client?.isAttached() && !historyActiveRef.current
          && buffer?.type === "normal" && buffer.baseY === 0) {
          if (Date.now() - historyFailedAtRef.current < AUTO_HISTORY_COOLDOWN_MS) return false;
          exportScrollback(true);
          return false; // 本次滚轮用于触发导出，交给 xterm 也没有可滚内容
        }
        return true;
      });
      terminal.onWriteParsed(() => {
        if (!historyActiveRef.current || !terminal || !hasVisibleTranscript(terminal)) return;
        // `[` 只在 detailed viewer 中是 print to scrollback；普通画面不得盲发。
        const attached = client?.isAttached() ?? false;
        if (attached) client?.input("[");
        finishHistory(attached
          ? "已发送导出，滚轮可查看"
          : "历史视图已打开，但终端连接已断开", attached);
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
      historyScrollAfterExportRef.current = false;
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
      if (historyScrollTimerRef.current) clearTimeout(historyScrollTimerRef.current);
      historyScrollTimerRef.current = null;
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
        <button type="button" disabled={historyBusy} onClick={() => { exportScrollback(); }}>可滚历史</button>
        <span className="terminal-shortcuts">选区 Ctrl+C 复制 · 无选区 Ctrl+C 中断 · Ctrl+Shift+C/V 复制/粘贴</span>
        {actionMessage ? <span className="terminal-action-status" role="status">{actionMessage}</span> : null}
      </section>
      <div className="terminal-xterm" ref={hostRef} aria-label="Claude Code 终端" />
      <footer className="terminal-footer">向上滚动会自动导出可滚历史（也可点“可滚历史”手动导出），之后可用滚轮浏览和选择复制；关闭窗口或刷新会结束本次插件终端，聊天记录仍保留。</footer>
    </main>
  );
}
