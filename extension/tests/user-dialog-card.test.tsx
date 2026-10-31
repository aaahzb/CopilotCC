/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserDialogCard } from "../src/components/UserDialogCard";
import { InteractionRecordView } from "../src/components/InteractionRecordView";
import type { InteractionRecord, InteractionRequest, UserDialogResponse } from "../src/lib/protocol";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/** 挂载真实对话框卡并返回 DOM 与应答 spy。 */
function mount(request: InteractionRequest): { host: HTMLDivElement; onRespond: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onRespond = vi.fn<(requestId: string, response: UserDialogResponse) => void>();
  act(() => root.render(<UserDialogCard request={request} onRespond={onRespond} />));
  return { host, onRespond };
}

/** 点击卡片中指定中文按钮。 */
function click(host: HTMLElement, text: string): void {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent === text);
  if (!button) throw new Error(`找不到按钮：${text}`);
  act(() => button.click());
}

describe("UserDialogCard CLI 自有对话框", () => {
  it("回退确认显示原模型、回退模型和指导，并返回三个真实 CLI 结果", () => {
    const { host, onRespond } = mount({
      requestId: "dialog-refusal", kind: "user_dialog",
      userDialog: {
        dialogKind: "refusal_fallback_prompt", originalModel: "claude-opus-5-5",
        fallbackModel: "claude-opus-4-8", apiRefusalCategory: "cyber",
        guidanceText: "可以调整提问，或改用回退模型重试。",
      },
    });
    expect(host.textContent).toContain("模型回退确认");
    expect(host.textContent).toContain("claude-opus-5-5");
    expect(host.textContent).toContain("claude-opus-4-8");
    expect(host.textContent).toContain("可以调整提问");
    click(host, "使用回退模型重试");
    expect(onRespond).toHaveBeenLastCalledWith("dialog-refusal", { action: "retry_fallback" });
    click(host, "返回修改提问");
    expect(onRespond).toHaveBeenLastCalledWith("dialog-refusal", { action: "edit_prompt" });
    click(host, "取消");
    expect(onRespond).toHaveBeenLastCalledWith("dialog-refusal", { action: "cancelled" });
  });

  it("自动模式显示标题、全部说明和安全帮助链接，继续与停止不混用", () => {
    const { host, onRespond } = mount({
      requestId: "dialog-auto", kind: "user_dialog",
      userDialog: {
        dialogKind: "auto_mode_server_fallback", gatewayHost: "gateway.example.com",
        title: "自动模式需要你的确认", paragraphs: ["第一段说明", "第二段说明"],
        helpUrl: "https://user:pass@example.com/help?from=claude",
      },
    });
    expect(host.textContent).toContain("自动模式需要你的确认");
    expect(host.textContent).toContain("第一段说明");
    expect(host.textContent).toContain("第二段说明");
    expect(host.textContent).toContain("gateway.example.com");
    const link = host.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe("https://example.com/help?from=claude");
    expect(link?.rel).toContain("noopener");
    click(host, "继续自动模式");
    expect(onRespond).toHaveBeenLastCalledWith("dialog-auto", { action: "continue" });
    click(host, "停止本轮");
    expect(onRespond).toHaveBeenLastCalledWith("dialog-auto", { action: "interrupt" });
    click(host, "取消");
    expect(onRespond).toHaveBeenLastCalledWith("dialog-auto", { action: "cancelled" });
  });

  it("非 http/https 帮助地址不渲染成可点击链接", () => {
    const { host } = mount({
      requestId: "dialog-unsafe", kind: "user_dialog",
      userDialog: {
        dialogKind: "auto_mode_server_fallback", title: "说明", paragraphs: [],
        helpUrl: "javascript:alert(1)",
      },
    });
    expect(host.querySelector("a")).toBeNull();
  });

  it("只读记录直接显示真实选择、模型与说明，不笼统写成已允许", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const record: InteractionRecord = {
      requestId: "dialog-record", kind: "user_dialog", outcome: "answered", resolvedAt: 1,
      decider: "user", userDialogAction: "retry_fallback",
      userDialog: {
        dialogKind: "refusal_fallback_prompt", originalModel: "opus", fallbackModel: "sonnet",
        guidanceText: "完整指导",
      },
    };
    act(() => root.render(<InteractionRecordView record={record} />));
    expect(host.textContent).toContain("你的选择：使用回退模型重试");
    expect(host.textContent).toContain("原模型：opus");
    expect(host.textContent).toContain("回退模型：sonnet");
    expect(host.textContent).toContain("完整指导");
    expect(host.textContent).not.toContain("已允许");
  });

  it("自动模式停止结果和取消结局均有可读记录", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const base: InteractionRecord = {
      requestId: "dialog-auto-record", kind: "user_dialog", outcome: "answered", resolvedAt: 1,
      userDialogAction: "interrupt",
      userDialog: {
        dialogKind: "auto_mode_server_fallback", title: "自动模式", paragraphs: ["完整说明"],
        helpUrl: "https://example.com/help",
      },
    };
    act(() => root.render(<InteractionRecordView record={base} />));
    expect(host.textContent).toContain("你的选择：停止本轮");
    expect(host.textContent).toContain("完整说明");
    act(() => root.render(<InteractionRecordView record={{
      ...base, outcome: "cancelled", userDialogAction: undefined,
    }} />));
    expect(host.textContent).toContain("已取消");
  });
});
