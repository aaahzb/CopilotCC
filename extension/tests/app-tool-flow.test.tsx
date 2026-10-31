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
    attachEnabled: true,
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

vi.mock("../src/lib/page-extract", () => ({
  snapshotActiveTab: vi.fn(async () => ({
    page: { url: "https://example.com/doc", title: "测试页面", markdown: "不应进入斜杠命令的页面正文", selection: "选中文字" },
    error: null,
  })),
  snapshotTab: vi.fn(async () => ({ page: null, error: "测试不使用弹窗页面" })),
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

describe("App 斜杠命令发送", () => {
  it("开启网页附带并存在选中文字时，/compact 仍只发送原始命令且无附带提示", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "folder.bound", path: "D:\\notes", resumed: false, title: "", sessionId: null, reset: true });
    await emit(ws, { type: "chat.draft", text: "/compact" });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "发送")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const sent = ws.sent.map((raw) => JSON.parse(raw) as { type: string; text?: string; display?: string; note?: string });
    expect(sent.find((message) => message.type === "chat.send")).toEqual({
      type: "chat.send", text: "/compact", display: "/compact",
    });
  });
});

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
    await emit(ws, { type: "chat.sync", busy: false, streamText: "", user: null, permReq: null, askReq: null, draft: "", compacting: true });
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

describe("App API 请求中状态", () => {
  it("实时帧和快照恢复提示，done/error/aborted 均清除", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.requesting", requesting: true } as unknown as ServerMessage);
    expect(host.textContent).toContain("正在请求 API");
    await emit(ws, {
      type: "chat.sync", busy: false, streamText: "", user: null, permReq: null, askReq: null,
      draft: "", compacting: false, requesting: false,
    } as unknown as ServerMessage);
    expect(host.textContent).not.toContain("正在请求 API");
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "", user: null, permReq: null, askReq: null,
      draft: "", compacting: false, requesting: true,
    } as unknown as ServerMessage);
    expect(host.textContent).toContain("正在请求 API");
    await emit(ws, { type: "chat.done", sessionId: "sid-1" });
    expect(host.textContent).not.toContain("正在请求 API");

    for (const terminal of [
      { type: "chat.error", message: "失败" },
      { type: "chat.aborted" },
    ] as const) {
      await emit(ws, { type: "chat.requesting", requesting: true } as unknown as ServerMessage);
      expect(host.textContent).toContain("正在请求 API");
      await emit(ws, terminal);
      expect(host.textContent).not.toContain("正在请求 API");
    }
  });

  it("断线立即清除请求中提示", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.requesting", requesting: true } as unknown as ServerMessage);
    expect(host.textContent).toContain("正在请求 API");
    await act(async () => ws.close());
    expect(host.textContent).not.toContain("正在请求 API");
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

  it("工具结果更新同一活动行，完整参数与输出默认折叠可展开", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.tool", name: "Bash", summary: "printf ok", toolUseId: "toolu-1", status: "running",
      input: JSON.stringify({ command: "printf ok" }, null, 2),
    } as unknown as ServerMessage);
    expect(host.querySelector(".tool-status")?.textContent).toBe("执行中");
    await emit(ws, {
      type: "chat.tool", name: "Bash", summary: "printf ok", toolUseId: "toolu-1", status: "success", output: "第一行\n第二行",
    } as unknown as ServerMessage);
    expect(host.querySelectorAll(".tool-activity")).toHaveLength(1);
    expect(host.querySelector(".tool-status")?.textContent).toBe("已完成");
    const details = host.querySelectorAll<HTMLDetailsElement>(".tool-activity details");
    expect(details).toHaveLength(2);
    expect(Array.from(details).every((d) => !d.open)).toBe(true);
    expect(host.querySelector(".tool-activity")?.textContent).toContain("第一行\n第二行");
  });

  it("工具与同 toolUseId 的权限记录分行保留，正文和决定顺序不丢", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.delta", text: "写入前" });
    await emit(ws, {
      type: "chat.tool", name: "Write", summary: "D:\\notes\\allowed.txt", toolUseId: "toolu-write-permission",
      status: "running", input: JSON.stringify({ file_path: "D:\\notes\\allowed.txt", content: "完整内容" }, null, 2),
    } as unknown as ServerMessage);
    await emit(ws, {
      type: "permission.resolved", requestId: "perm-write-1",
      record: {
        requestId: "perm-write-1", kind: "permission", tool: "Write", toolUseId: "toolu-write-permission",
        outcome: "allowed", resolvedAt: 2, detail: "完整审批参数",
      },
    } as unknown as ServerMessage);
    await emit(ws, {
      type: "chat.tool", name: "Write", summary: "D:\\notes\\allowed.txt", toolUseId: "toolu-write-permission",
      status: "success", output: "文件写入成功",
    } as unknown as ServerMessage);
    await emit(ws, { type: "chat.delta", text: "写入后" });
    await emit(ws, { type: "chat.done", sessionId: "sid-1" });
    const items = Array.from(host.querySelectorAll(
      ".message-list > .msg.assistant, .message-list > .tool-activity, .message-list > .interaction-record",
    ));
    expect(items.map((el) => el.textContent)).toEqual([
      "写入前", expect.stringContaining("文件写入成功"), expect.stringContaining("已允许"), "写入后",
    ]);
    expect(host.querySelectorAll(".tool-activity")).toHaveLength(1);
    expect(host.querySelectorAll(".interaction-record")).toHaveLength(1);
    expect(host.querySelector(".tool-status")?.textContent).toBe("已完成");
  });

  it("正文→工具→正文保持真实顺序，工具到来时先落定前一段", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.delta", text: "前文" });
    await emit(ws, { type: "chat.tool", name: "Read", summary: "a.txt", toolUseId: "toolu-order", status: "running" } as unknown as ServerMessage);
    await emit(ws, { type: "chat.delta", text: "后文" });
    await emit(ws, { type: "chat.done", sessionId: "sid-1" });
    const items = Array.from(host.querySelectorAll(".message-list > .msg.assistant, .message-list > .tool-activity"));
    expect(items.map((el) => el.textContent)).toEqual(["前文", expect.stringContaining("Read"), "后文"]);
  });

  it("轮次错误保留已生成正文，再显示错误", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.delta", text: "已经写出的内容" });
    await emit(ws, { type: "chat.error", message: "连接失败" });
    const bubbles = Array.from(host.querySelectorAll(".msg.assistant")).map((el) => el.textContent);
    expect(bubbles).toEqual(["已经写出的内容", "⚠️ 连接失败"]);
  });

  it("已由 chat.timeline 上屏的错误和停止终结帧不重复追加", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.timeline",
      item: { id: "terminal-error", createdAt: 1, role: "assistant", text: "⚠️ 连接失败" },
    } as unknown as ServerMessage);
    await emit(ws, { type: "chat.error", message: "连接失败", recorded: true } as unknown as ServerMessage);
    await emit(ws, {
      type: "chat.timeline",
      item: { id: "terminal-abort", createdAt: 2, role: "assistant", text: "⏹ 已手动停止本轮生成" },
    } as unknown as ServerMessage);
    await emit(ws, { type: "chat.aborted", recorded: true } as unknown as ServerMessage);
    expect(Array.from(host.querySelectorAll(".msg.assistant")).map((el) => el.textContent)).toEqual([
      "⚠️ 连接失败", "⏹ 已手动停止本轮生成",
    ]);
  });

  it("chat.sync.timeline 恢复在途顺序，末尾正文继续流式且不重复用户气泡", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "前文后文", user: { display: "在途问题", sent: "在途问题" },
      permReq: null, askReq: null, draft: "", compacting: false,
      timeline: [
        { id: "turn-user", createdAt: 1, role: "user", text: "在途问题", sentText: "在途问题" },
        { id: "turn-a1", createdAt: 2, role: "assistant", text: "前文" },
        { id: "tool-timeline", createdAt: 3, role: "tool", toolName: "Bash", text: "printf ok", toolUseId: "toolu-timeline", toolStatus: "success", toolOutput: "ok" },
        { id: "turn-a2", createdAt: 4, role: "assistant", text: "后文" },
      ],
    } as unknown as ServerMessage);
    expect(host.querySelectorAll(".msg.user")).toHaveLength(1);
    let items = Array.from(host.querySelectorAll(".message-list > .msg.assistant, .message-list > .tool-activity"));
    expect(items.map((el) => el.textContent)).toEqual(["前文", expect.stringContaining("printf ok"), "后文"]);
    expect(host.querySelector(".tool-status")?.textContent).toBe("已完成");
    await emit(ws, { type: "chat.delta", text: "！" });
    items = Array.from(host.querySelectorAll(".message-list > .msg.assistant, .message-list > .tool-activity"));
    expect(items.map((el) => el.textContent)).toEqual(["前文", expect.stringContaining("printf ok"), "后文！"]);
  });

  it("chat.timeline 状态记录实时显示，终结帧与重连快照不重复上屏", async () => {
    const { host, ws } = await mountApp();
    const item = {
      id: "compact-status-1", createdAt: 1, role: "tool" as const,
      text: "🗜 已压缩上下文 156k → 42k tokens（-73%）",
    };
    await emit(ws, { type: "chat.timeline", item } as unknown as ServerMessage);
    expect(host.querySelectorAll(".message-list > .tool-card")).toHaveLength(1);
    await emit(ws, {
      type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000, recorded: true,
    } as unknown as ServerMessage);
    expect(host.querySelectorAll(".message-list > .tool-card")).toHaveLength(1);
    await emit(ws, {
      type: "chat.sync", busy: false, streamText: "", user: null, permReq: null, askReq: null,
      draft: "", compacting: false, timeline: [item],
    } as unknown as ServerMessage);
    expect(host.querySelectorAll(".message-list > .tool-card")).toHaveLength(1);
    expect(host.querySelector(".message-list > .tool-card")?.textContent).toContain("156k → 42k");
  });

  it("状态记录的技术详情默认折叠且保留全文", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.timeline",
      item: {
        id: "usage-1", createdAt: 1, role: "tool", text: "用量：输入 12 · 输出 34 tokens",
        detail: '{\n  "input_tokens": 12,\n  "output_tokens": 34\n}',
      },
    } as unknown as ServerMessage);
    const detail = host.querySelector<HTMLDetailsElement>("details.status-detail");
    expect(detail?.open).toBe(false);
    expect(detail?.textContent).toContain('"output_tokens": 34');
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

  it("加载更早记录只前插旧消息，保留最新历史与流式正文", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "session.history.data",
      messages: [
        { id: "h-3", createdAt: 3, role: "assistant", text: "消息 3" },
        { id: "h-4", createdAt: 4, role: "assistant", text: "消息 4" },
      ],
      hasMore: true,
      nextCursor: "h-3",
    });
    await emit(ws, { type: "chat.delta", text: "正在回答" });
    const more = host.querySelector<HTMLButtonElement>("button.history-more");
    expect(more?.textContent).toBe("加载更早记录");
    await act(async () => more?.click());
    expect(ws.sent.map((raw) => JSON.parse(raw) as { type: string })).toContainEqual({
      type: "session.history", before: "h-3", limit: 100,
    });
    await emit(ws, {
      type: "session.history.data", before: "h-3", hasMore: false,
      messages: [
        { id: "h-1", createdAt: 1, role: "assistant", text: "消息 1" },
        { id: "h-2", createdAt: 2, role: "assistant", text: "消息 2" },
      ],
    });
    expect(Array.from(host.querySelectorAll(".msg.assistant")).map((el) => el.textContent))
      .toEqual(["消息 1", "消息 2", "消息 3", "消息 4", "正在回答"]);
    expect(host.querySelector("button.history-more")).toBeNull();
  });
});

describe("App AskUserQuestion 提问卡片", () => {
  const questions = [{ question: "选哪个方案？", header: "方案", options: [{ label: "方案 A" }, { label: "方案 B" }], multiSelect: false }];

  it("chat.ask 显示卡片，提交发送 chat.ask.answer 并立即撤下", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.ask", requestId: "ask-1", questions });
    expect(host.querySelector(".ask-card")?.textContent).toContain("选哪个方案？");
    await act(async () => {
      const input = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((el) => el.value === "方案 A");
      input?.click();
    });
    await act(async () => host.querySelector<HTMLButtonElement>('.ask-card button[type="submit"]')?.click());
    const frames = ws.sent.map((raw) => JSON.parse(raw) as { type: string; requestId?: string; answers?: Record<string, string> });
    expect(frames.find((m) => m.type === "chat.ask.answer")).toEqual({
      type: "chat.ask.answer", requestId: "ask-1", answers: { "选哪个方案？": "方案 A" },
    });
    expect(host.querySelector(".ask-card")).toBeNull();
  });

  it("作答后的 resolved 携带记录：撤卡但永久显示问题与实际选择", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.ask", requestId: "ask-1", questions });
    await emit(ws, {
      type: "chat.ask.resolved",
      requestId: "ask-1",
      record: {
        requestId: "ask-1", kind: "ask", outcome: "answered", resolvedAt: 1,
        questions, answers: { "选哪个方案？": "方案 A" },
      },
    } as unknown as ServerMessage);
    expect(host.querySelector(".ask-card")).toBeNull();
    const record = host.querySelector(".interaction-record");
    expect(record?.textContent).toContain("选哪个方案？");
    expect(record?.textContent).toContain("你的选择：方案 A");
  });

  it("chat.sync 恢复已解决记录与多个挂起提问，不只恢复最后一张卡", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "", user: null, permReq: null, askReq: null, draft: "", compacting: false,
      pendingInteractions: [
        { requestId: "ask-1", kind: "ask", questions },
        { requestId: "ask-2", kind: "ask", questions: [{ ...questions[0]!, question: "第二题" }] },
      ],
      interactions: [{
        requestId: "ask-old", kind: "ask", outcome: "answered", resolvedAt: 1,
        questions, answers: { "选哪个方案？": "旧答案" },
      }],
    } as unknown as ServerMessage);
    expect(host.querySelectorAll(".ask-card")).toHaveLength(2);
    expect(host.querySelector(".interaction-record")?.textContent).toContain("你的选择：旧答案");
  });

  it("历史与实时记录按 toolUseId 去重，resolved 更新同一张只读卡", async () => {
    const { host, ws } = await mountApp();
    const base = {
      kind: "ask", tool: "AskUserQuestion", toolUseId: "toolu-ask-1", outcome: "answered", resolvedAt: 1,
      questions, answers: { "选哪个方案？": "旧答案" },
    };
    await emit(ws, {
      type: "session.history.data",
      messages: [{ role: "tool", text: "已回答", interaction: { ...base, requestId: "history-toolu-ask-1" } }],
    } as unknown as ServerMessage);
    await emit(ws, {
      type: "chat.ask.resolved", requestId: "ask-live",
      record: { ...base, requestId: "ask-live", answers: { "选哪个方案？": "新答案" } },
    } as unknown as ServerMessage);
    expect(host.querySelectorAll(".interaction-record")).toHaveLength(1);
    expect(host.querySelector(".interaction-record")?.textContent).toContain("你的选择：新答案");
  });

  it("其他视图作答后的 chat.ask.resolved 撤下本视图卡片", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.ask", requestId: "ask-1", questions });
    expect(host.querySelector(".ask-card")).not.toBeNull();
    await emit(ws, { type: "chat.ask.resolved", requestId: "ask-1" });
    expect(host.querySelector(".ask-card")).toBeNull();
  });

  it("chat.sync.askReq 恢复接入前已挂起的提问", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "", user: null, permReq: null,
      askReq: { requestId: "ask-1", questions }, draft: "", compacting: false,
    });
    expect(host.querySelector(".ask-card")?.textContent).toContain("选哪个方案？");
  });

  it("手动中止同时撤下挂起提问", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.ask", requestId: "ask-1", questions });
    await emit(ws, { type: "chat.aborted" });
    expect(host.querySelector(".ask-card")).toBeNull();
  });
});

describe("App MCP 独立交互", () => {
  const request = {
    requestId: "el-live", kind: "elicitation" as const,
    elicitation: {
      serverName: "docs", message: "请填写名称", mode: "form" as const,
      fields: [{ name: "name", title: "名称", type: "string" as const, required: true }],
    },
  };

  it("通用实时帧显示表单，提交 content 后 resolved 撤卡并只保留字段名", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.interaction", request });
    expect(host.querySelector(".elicitation-card")?.textContent).toContain("请填写名称");
    const input = host.querySelector<HTMLInputElement>('.elicitation-card input[name="name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "秘密值");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".elicitation-card button")).find((button) => button.textContent === "提交")?.click();
    });
    expect(ws.sent.map((raw) => JSON.parse(raw) as { type: string })).toContainEqual({
      type: "chat.interaction.respond", requestId: "el-live",
      response: { action: "accept", content: { name: "秘密值" } },
    });
    await emit(ws, {
      type: "chat.interaction.resolved", requestId: "el-live",
      record: {
        ...request, outcome: "answered", resolvedAt: 1, decider: "user",
        elicitationAction: "accept", submittedFields: ["name"],
      },
    });
    expect(host.querySelector(".elicitation-card")).toBeNull();
    expect(host.querySelector(".interaction-record")?.textContent).toContain("已提交字段：name");
    expect(host.querySelector(".interaction-record")?.textContent).not.toContain("秘密值");
  });

  it("快照恢复挂起卡，elicitation_complete 更新同一 URL 记录", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "", user: null, permReq: null, askReq: null,
      draft: "", compacting: false, pendingInteractions: [request], interactions: [],
    });
    expect(host.querySelectorAll(".elicitation-card")).toHaveLength(1);

    const urlRecord = {
      requestId: "el-url", kind: "elicitation" as const, outcome: "allowed" as const, resolvedAt: 1,
      elicitationAction: "accept" as const,
      elicitation: { serverName: "docs", message: "请登录", mode: "url" as const, elicitationId: "el-1", url: "https://example.com/auth" },
    };
    await emit(ws, { type: "chat.interaction.resolved", requestId: "el-url", record: urlRecord });
    await emit(ws, {
      type: "chat.interaction.resolved", requestId: "el-url",
      record: { ...urlRecord, elicitationComplete: true },
    });
    expect(host.querySelectorAll('[data-request-id="el-url"]')).toHaveLength(1);
    expect(host.querySelector('[data-request-id="el-url"]')?.textContent).toContain("链接流程已完成");
  });
});

describe("App CLI UserDialog 独立交互", () => {
  const refusal = {
    requestId: "dialog-live", kind: "user_dialog" as const,
    userDialog: {
      dialogKind: "refusal_fallback_prompt" as const,
      originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8",
      guidanceText: "可以改用回退模型",
    },
  };

  it("实时卡发送真实选择，resolved 双视图撤卡后留下同一条中文结果", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, { type: "chat.interaction", request: refusal });
    expect(host.querySelector(".user-dialog-card")?.textContent).toContain("claude-opus-4-8");
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".user-dialog-card button"))
        .find((button) => button.textContent === "使用回退模型重试")?.click();
    });
    expect(ws.sent.map((raw) => JSON.parse(raw) as { type: string })).toContainEqual({
      type: "chat.interaction.respond", requestId: "dialog-live",
      response: { action: "retry_fallback" },
    });
    await emit(ws, {
      type: "chat.interaction.resolved", requestId: "dialog-live",
      record: {
        ...refusal, outcome: "answered", resolvedAt: 1, decider: "user",
        userDialogAction: "retry_fallback",
      },
    });
    expect(host.querySelector(".user-dialog-card")).toBeNull();
    expect(host.querySelectorAll('[data-request-id="dialog-live"]')).toHaveLength(1);
    expect(host.querySelector(".interaction-record")?.textContent).toContain("你的选择：使用回退模型重试");
  });

  it("快照恢复自动模式挂起卡，不把它误渲染成 MCP 或普通权限卡", async () => {
    const { host, ws } = await mountApp();
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "", user: null, permReq: null, askReq: null,
      draft: "", compacting: false, interactions: [],
      pendingInteractions: [{
        requestId: "dialog-auto-sync", kind: "user_dialog",
        userDialog: {
          dialogKind: "auto_mode_server_fallback", title: "自动模式确认",
          paragraphs: ["完整说明"], helpUrl: "https://example.com/help",
        },
      }],
    });
    expect(host.querySelector(".user-dialog-card")?.textContent).toContain("自动模式确认");
    expect(host.querySelector(".elicitation-card")).toBeNull();
    expect(host.querySelector(".permission-card")).toBeNull();
  });
});

describe("App 计划审批完整链路", () => {
  it("快照恢复完整计划卡，退回意见发送给桥接并留下只读记录", async () => {
    const { host, ws } = await mountApp();
    const plan = "# 完整计划\n\n1. 第一步\n2. 第二步";
    await emit(ws, {
      type: "chat.sync", busy: true, streamText: "", user: null, permReq: null, askReq: null, draft: "", compacting: false,
      pendingInteractions: [{
        requestId: "plan-live", kind: "exit_plan", tool: "ExitPlanMode", toolUseId: "toolu-plan-live",
        summary: "申请批准计划并继续执行", plan, planFilePath: "D:\\plans\\live.md", detail: "{}",
      }],
    } as unknown as ServerMessage);
    expect(host.querySelector("details.plan-detail")?.textContent).toContain(plan);
    const textarea = host.querySelector<HTMLTextAreaElement>(".permission-card textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea!, "请补充验收");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>(".permission-card button")).find((b) => b.textContent === "继续修改")?.click();
    });
    expect(ws.sent.map((raw) => JSON.parse(raw) as { type: string })).toContainEqual({
      type: "permission.response", requestId: "plan-live", allow: false, feedback: "请补充验收",
    });
    await emit(ws, {
      type: "permission.resolved", requestId: "plan-live",
      record: {
        requestId: "plan-live", kind: "exit_plan", tool: "ExitPlanMode", toolUseId: "toolu-plan-live",
        outcome: "denied", decider: "user", resolvedAt: 1, feedback: "请补充验收", plan, detail: "{}",
      },
    } as unknown as ServerMessage);
    expect(host.querySelector(".permission-card")).toBeNull();
    expect(host.querySelector(".interaction-record")?.textContent).toContain("你的意见：请补充验收");
    expect(host.querySelector(".interaction-record details")?.textContent).toContain(plan);
  });
});
