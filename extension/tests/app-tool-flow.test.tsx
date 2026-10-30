/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/entrypoints/sidepanel/App";
import type { ServerMessage } from "../src/lib/protocol";

vi.mock("../src/lib/storage", () => ({
  loadSettings: vi.fn(async () => ({
    token: "test-token",
    port: 19280,
    host: "127.0.0.1",
    folderHistory: [],
    attachEnabled: false,
    permissionMode: "auto",
    model: "",
    effort: "",
    fastMode: false,
    lastFolder: "",
  })),
  saveSettings: vi.fn(),
  pushFolderHistory: vi.fn(async () => {}),
  takePendingQuote: vi.fn(async () => null),
  loadRuntimeCache: vi.fn(async () => ({})),
  saveRuntimeCache: vi.fn(async () => {}),
  clearRuntimeCache: vi.fn(async () => {}),
}));

/** 可控 WebSocket：走真实 BridgeClient，但由测试注入桥接帧。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/** 挂载真实 App，等待设置加载并建立假 WS 连接。 */
async function mountApp(): Promise<{ host: HTMLDivElement; ws: FakeWebSocket }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const ws = FakeWebSocket.instances[0];
  if (!ws) throw new Error("App 未创建 WebSocket");
  await act(async () => ws.open());
  return { host, ws };
}

/** 注入一帧并刷新 React 状态。 */
async function emit(ws: FakeWebSocket, message: ServerMessage): Promise<void> {
  await act(async () => ws.emit(message));
}

describe("App 压缩进度显示", () => {
  it("start 后状态栏出现“正在压缩”，done 插入记录行并清除提示", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.compact", phase: "start" });
    expect(host.textContent).toContain("正在压缩…（0s）");
    await emit(ws, { type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    expect(host.textContent).toContain("🗜 已压缩上下文 156k → 42k tokens（-73%）");
    expect(host.textContent).not.toContain("正在压缩…");
  });

  it("failed 插入失败记录行", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.compact", phase: "done", result: "failed", error: "boom" });
    expect(host.textContent).toContain("⚠️ 上下文压缩失败：boom，继续使用当前上下文");
  });

  it("chat.sync.compacting=true 时状态栏有提示", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.sync", busy: false, streamText: "", user: null, permReq: null, draft: "", compacting: true });
    expect(host.textContent).toContain("正在压缩…");
  });

  it("断线清除压缩提示", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.compact", phase: "start" });
    expect(host.textContent).toContain("正在压缩…");
    await act(async () => {
      ws.close();
    });
    expect(host.textContent).not.toContain("正在压缩…");
  });
});

describe("App 工具活动消息流", () => {
  it("实时 chat.tool 经过 BridgeClient 和 App 后显示工具活动行", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.tool", name: "Write", summary: "D:\CopilotCC_Dir\simpleTable.md" });
    const activity = host.querySelector('.tool-activity[data-tool="Write"]');
    expect(activity).not.toBeNull();
    expect(activity?.querySelector(".tool-icon")?.textContent).toBe("📝");
    expect(activity?.querySelector(".tool-summary")?.textContent).toBe("D:\CopilotCC_Dir\simpleTable.md");
  });

  it("重载历史中的 toolName 也恢复为工具活动行", async () => {
    const { host, ws } = await mountApp();
    const history = {
      type: "session.history.data",
      messages: [
        { role: "user", text: "创建网站简介" },
        { role: "tool", toolName: "Write", text: "D:\CopilotCC_Dir\simpleTable.md" },
        { role: "assistant", text: "已创建网站简介" },
      ],
    } as unknown as ServerMessage;
    await emit(ws, history);
    expect(host.querySelector('.tool-activity[data-tool="Write"]')).not.toBeNull();
    expect(host.querySelector(".msg.user")?.textContent).toContain("创建网站简介");
    expect(host.querySelector(".msg.assistant")?.textContent).toContain("已创建网站简介");
  });
});
