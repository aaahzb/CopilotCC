/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const terminalInstances: Array<{
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    open: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    hasSelection: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    onSelectionChange: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    attachCustomWheelEventHandler: ReturnType<typeof vi.fn>;
    scrollPages: ReturnType<typeof vi.fn>;
    onWriteParsed: ReturnType<typeof vi.fn>;
    selection: string;
    lines: string[];
    buffer: {
      active: { type: "normal" | "alternate"; baseY: number; viewportY: number; length: number;
        getLine(index: number): { translateToString(trim: boolean): string } | undefined };
    };
    dataCallback?: (data: string) => void;
    selectionCallback?: () => void;
    keyHandler?: (event: KeyboardEvent) => boolean;
    wheelHandler?: (event: WheelEvent) => boolean;
    writeParsedCallback?: () => void;
  }> = [];
  const clientInstances: Array<{
    options: {
      getUrl(): string;
      onView(view: { phase: string; message: string; terminal: unknown; exitCode: number | null }): void;
      onAttached?(): void;
    };
    connect: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    closePage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    attached: boolean;
  }> = [];
  return { terminalInstances, clientInstances };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    dataCallback?: (data: string) => void;
    selectionCallback?: () => void;
    keyHandler?: (event: KeyboardEvent) => boolean;
    wheelHandler?: (event: WheelEvent) => boolean;
    writeParsedCallback?: () => void;
    selection = "";
    lines: string[] = [];
    buffer: (typeof mocks.terminalInstances)[number]["buffer"] = {
      active: {
        type: "normal",
        baseY: 0,
        viewportY: 0,
        length: 24,
        getLine: (index: number) => ({ translateToString: () => this.lines[index] ?? "" }),
      },
    };
    constructor(readonly options: Record<string, unknown>) {
      mocks.terminalInstances.push(this as never);
    }
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn((callback: (data: string) => void) => { this.dataCallback = callback; });
    hasSelection = vi.fn(() => this.selection.length > 0);
    getSelection = vi.fn(() => this.selection);
    paste = vi.fn((data: string) => { this.dataCallback?.(data); });
    focus = vi.fn();
    onSelectionChange = vi.fn((callback: () => void) => { this.selectionCallback = callback; });
    attachCustomKeyEventHandler = vi.fn((callback: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = callback;
    });
    attachCustomWheelEventHandler = vi.fn((callback: (event: WheelEvent) => boolean) => {
      this.wheelHandler = callback;
    });
    scrollPages = vi.fn();
    onWriteParsed = vi.fn((callback: () => void) => { this.writeParsedCallback = callback; });
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("../src/lib/terminal-client", () => ({
  TerminalClient: class {
    options: (typeof mocks.clientInstances)[number]["options"];
    attached = false;
    connect = vi.fn();
    input = vi.fn();
    resize = vi.fn(() => { this.attached = true; });
    stop = vi.fn();
    closePage = vi.fn();
    close = vi.fn();
    isAttached(): boolean { return this.attached; }
    constructor(options: (typeof mocks.clientInstances)[number]["options"]) {
      this.options = options;
      mocks.clientInstances.push(this as never);
    }
  },
}));
vi.mock("../src/lib/storage", () => ({
  loadSettings: vi.fn(async () => ({
    token: "test-token", port: 19280, host: "127.0.0.1", folderHistory: [],
    attachEnabled: true, permissionMode: "auto", model: "", effort: "", fastMode: false, lastFolder: "",
  })),
}));

import TerminalApp from "../src/entrypoints/terminal/TerminalApp";

const roots: Root[] = [];
let resizeCallback: ResizeObserverCallback | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  mocks.terminalInstances.length = 0;
  mocks.clientInstances.length = 0;
  resizeCallback = null;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe = vi.fn();
    disconnect = vi.fn();
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 挂载真实终端组件并等待设置、xterm 和客户端初始化。 */
async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<TerminalApp />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

describe("TerminalApp 真实 xterm 接线", () => {
  it("onData 原样发送中文，attached 后立即 fit 并同步真实行列", async () => {
    await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.options.getUrl()).toBe("ws://127.0.0.1:19280/ws?token=test-token");
    term.cols = 132;
    term.rows = 36;
    client.attached = true; // 模拟真实 TerminalClient 收到 terminal.attached 后的公开状态。
    await act(async () => client.options.onAttached?.());
    expect(client.resize).toHaveBeenCalledWith(132, 36);
    await act(async () => term.dataCallback?.("中文\r"));
    expect(client.input).toHaveBeenCalledWith("中文\r");
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(client.resize).toHaveBeenCalledWith(132, 36);
  });

  it("公开页头显示 folder/session，不显示 token；结束按钮只结束后端", async () => {
    const host = await mount();
    const client = mocks.clientInstances[0]!;
    await act(async () => client.options.onView({
      phase: "attached", message: "终端已连接", exitCode: null,
      terminal: {
        leaseId: "11111111-1111-4111-8111-111111111111", mode: "embedded", phase: "active",
        folder: "D:\\notes", initialSessionId: "sid-initial", currentSessionId: "sid-current",
        backend: "pty", canManualRelease: false,
      },
    }));
    expect(host.textContent).toContain("D:\\notes");
    expect(host.textContent).toContain("sid-current");
    expect(host.textContent).not.toContain("test-token");
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => item.textContent === "结束终端");
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(client.closePage).not.toHaveBeenCalled();
  });

  it("选择变化控制复制按钮，复制成功和失败都有可见反馈", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText, readText: vi.fn() } });
    const copy = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "复制");
    expect(copy()?.disabled).toBe(true);
    term.selection = "选中的中文\n第二行";
    await act(async () => term.selectionCallback?.());
    expect(copy()?.disabled).toBe(false);
    await act(async () => copy()?.click());
    expect(writeText).toHaveBeenCalledWith("选中的中文\n第二行");
    expect(host.textContent).toContain("已复制");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => copy()?.click());
    expect(host.textContent).toContain("复制失败");
  });

  it("粘贴按钮把中文多行文本交给 terminal.paste 并沿用真实输入链", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    const readText = vi.fn().mockResolvedValue("第一行\n第二行中文");
    vi.stubGlobal("navigator", { clipboard: { readText, writeText: vi.fn() } });
    const paste = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "粘贴");
    await act(async () => paste?.click());
    expect(term.paste).toHaveBeenCalledWith("第一行\n第二行中文");
    expect(client.input).toHaveBeenCalledWith("第一行\n第二行中文");
    expect(host.textContent).toContain("已粘贴");
    readText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => paste?.click());
    expect(host.textContent).toContain("粘贴失败");
  });

  it("Ctrl+C 按选区区分复制与中断，Ctrl+Shift+C/V 始终复制粘贴", async () => {
    await mount();
    const term = mocks.terminalInstances[0]!;
    mocks.clientInstances[0]!.attached = true;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("快捷键粘贴");
    vi.stubGlobal("navigator", { clipboard: { writeText, readText } });
    const key = (ctrlKey: boolean, shiftKey = false) => new KeyboardEvent("keydown", {
      key: "c", ctrlKey, shiftKey, cancelable: true,
    });
    expect(term.keyHandler?.(key(true))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    term.selection = "复制选区";
    await act(async () => {
      expect(term.keyHandler?.(key(true))).toBe(false);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("复制选区");
    await act(async () => {
      expect(term.keyHandler?.(key(true, true))).toBe(false);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(2);
    const pasteKey = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, shiftKey: true, cancelable: true });
    await act(async () => {
      expect(term.keyHandler?.(pasteKey)).toBe(false);
      await Promise.resolve();
    });
    expect(term.paste).toHaveBeenCalledWith("快捷键粘贴");
  });

  it("可滚历史识别真实 transcript 页脚后发送导出键", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    const history = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "可滚历史");
    await act(async () => history?.click());
    expect(client.input).toHaveBeenCalledWith("\x0f");
    expect(client.input).not.toHaveBeenCalledWith("[");
    term.lines = ["普通 Claude Code 画面"];
    await act(async () => term.writeParsedCallback?.());
    expect(client.input).not.toHaveBeenCalledWith("[");
    term.lines = [
      "Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in notepad · ? for shortcuts",
    ];
    await act(async () => term.writeParsedCallback?.());
    expect(client.input).toHaveBeenCalledWith("[");
    expect(host.querySelector(".terminal-action-status")?.textContent).toContain("已发送导出");
  });

  it("真实 transcript 页脚没有 ↑↓ scroll 时也识别并发送导出键", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    const history = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "可滚历史");
    await act(async () => history?.click());
    // 2.1.323 窄窗口或 virtualScroll=false 时页脚只保留稳定段，没有 ↑↓ scroll。
    term.lines = ["Showing detailed transcript · ctrl+o to toggle · ctrl+e to show all/collapse · ? for shortcuts"];
    await act(async () => term.writeParsedCallback?.());
    expect(client.input).toHaveBeenCalledWith("[");
    expect(host.querySelector(".terminal-action-status")?.textContent).toContain("已发送导出");
  });

  it("普通画面只含 transcript 标题时不盲发导出键", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    const history = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "可滚历史");
    await act(async () => history?.click());
    // 只剩标题、没有稳定的 ctrl+o 切换提示，不能当作 detailed viewer 盲发 `[`。
    term.lines = ["Showing detailed transcript 导出进行中"];
    await act(async () => term.writeParsedCallback?.());
    expect(client.input).not.toHaveBeenCalledWith("[");
  });

  it("transcript 超时未出现时不盲发导出键，并提示手动键序", async () => {
    const host = await mount();
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    const history = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "可滚历史");
    vi.useFakeTimers();
    await act(async () => history?.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(client.input).toHaveBeenCalledWith("\x0f");
    expect(client.input).not.toHaveBeenCalledWith("[");
    expect(host.textContent).toContain("请手动按 Ctrl+O，再按 [");
  });

  it("视口上方没有任何原生历史时，向上滚轮自动执行可滚历史导出", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    // Claude Code 主画面原地重绘，buffer.baseY 为 0 时 xterm 无处可滚；
    // 旧实现只让用户点「可滚历史」，滚轮本身没有任何反应（Windows 实测）。
    term.lines = ["Claude Code 主界面已渲染"];
    let swallowed = true;
    await act(async () => { swallowed = term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 })) ?? true; });
    expect(swallowed).toBe(false);
    expect(client.input).toHaveBeenCalledWith("\x0f");
    expect(host.querySelector(".terminal-action-status")?.textContent).toContain("正在打开 CLI 历史视图");
  });

  it("首个字符出现前滚轮不启动自动导出，出现后滚轮立即可用", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    // 启动阶段画面还是空的：此时滚轮不能提前向 CLI 发送 Ctrl+O。CLI 尚未就绪时导出必然
    // 超时并进入 8 秒冷却，首字出现后的正常滚轮反而被冷却吞掉（真实机器复现）。
    let early = false;
    await act(async () => { early = term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 })) ?? true; });
    expect(early).toBe(true);
    expect(client.input).not.toHaveBeenCalledWith("\x0f");
    expect(host.querySelector(".terminal-action-status")).toBeNull();
    // 首字出现后的第一次滚轮必须能立即自动导出，不受启动阶段的干扰。
    term.lines = ["Claude Code 主界面已渲染"];
    let afterRender = true;
    await act(async () => { afterRender = term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 })) ?? true; });
    expect(afterRender).toBe(false);
    expect(client.input).toHaveBeenCalledWith("\x0f");
    expect(host.querySelector(".terminal-action-status")?.textContent).toContain("正在打开 CLI 历史视图");
  });

  it("已有原生历史、向下滚动或 alternate 缓冲区时滚轮仍交给 xterm", async () => {
    await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    term.buffer.active.baseY = 120;
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 }))).toBe(true);
    term.buffer.active.baseY = 0;
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: 120 }))).toBe(true);
    term.buffer.active.type = "alternate";
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 }))).toBe(true);
    expect(client.input).not.toHaveBeenCalledWith("\x0f");
  });

  it("滚轮触发导出成功后自动向上翻一页；按钮导出不改动用户视口", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    vi.useFakeTimers();
    // 画面已渲染（有可见字符）时滚轮才进入自动导出，见“首字未出现”回归用例。
    term.lines = ["Claude Code 主界面已渲染"];
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 }))).toBe(false);
    term.lines = ["Showing detailed transcript · ctrl+o to toggle"];
    await act(async () => { term.writeParsedCallback?.(); });
    expect(client.input).toHaveBeenCalledWith("[");
    // CLI 把整段 transcript 打印进正常缓冲区后才出现原生历史（baseY 增长）。
    term.buffer.active.baseY = 600;
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(term.scrollPages).toHaveBeenCalledWith(-1);

    term.scrollPages.mockClear();
    client.input.mockClear();
    const history = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "可滚历史");
    await act(async () => history?.click());
    expect(client.input).toHaveBeenCalledWith("\x0f");
    term.lines = ["Showing detailed transcript · ctrl+o to toggle"];
    await act(async () => { term.writeParsedCallback?.(); });
    expect(client.input).toHaveBeenCalledWith("[");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(term.scrollPages).not.toHaveBeenCalled();
  });

  it("自动导出超时后短暂冷却，滚轮不会连续打断 CLI", async () => {
    const host = await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    client.attached = true;
    vi.useFakeTimers();
    term.lines = ["Claude Code 主界面已渲染"];
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 }))).toBe(false);
    expect(client.input.mock.calls.filter((call) => call[0] === "\x0f")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(host.textContent).toContain("请手动按 Ctrl+O，再按 [");
    // 超时后继续滚轮不得反复发送 Ctrl+O。
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 }))).toBe(false);
    expect(client.input.mock.calls.filter((call) => call[0] === "\x0f")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(term.wheelHandler?.(new WheelEvent("wheel", { deltaY: -120 }))).toBe(false);
    expect(client.input.mock.calls.filter((call) => call[0] === "\x0f")).toHaveLength(2);
  });

  it("pagehide 只 closePage 一次；React 卸载随后 close 且 observer/term 被清理", async () => {
    await mount();
    const term = mocks.terminalInstances[0]!;
    const client = mocks.clientInstances[0]!;
    act(() => { window.dispatchEvent(new PageTransitionEvent("pagehide")); });
    act(() => { window.dispatchEvent(new PageTransitionEvent("pagehide")); });
    expect(client.closePage).toHaveBeenCalledTimes(1);
    act(() => roots.pop()?.unmount());
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(term.dispose).toHaveBeenCalledTimes(1);
  });
});
