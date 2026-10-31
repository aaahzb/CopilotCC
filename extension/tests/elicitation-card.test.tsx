/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElicitationCard } from "../src/components/ElicitationCard";
import { InteractionRecordView } from "../src/components/InteractionRecordView";
import type { InteractionRequest, InteractionRecord } from "../src/lib/protocol";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** 挂载 MCP 请求卡并返回真实 DOM 与应答 spy。 */
function mount(request: InteractionRequest): { host: HTMLDivElement; onRespond: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onRespond = vi.fn();
  act(() => root.render(<ElicitationCard request={request} onRespond={onRespond} />));
  return { host, onRespond };
}

/** 用原生 setter 触发受控 input 的 React 更新。 */
function inputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("ElicitationCard MCP 表单与链接", () => {
  it("渲染字符串、数字、布尔和枚举，提交真实类型及默认值", () => {
    const { host, onRespond } = mount({
      requestId: "el-form", kind: "elicitation",
      elicitation: {
        serverName: "docs", message: "请补充发布信息", mode: "form",
        fields: [
          { name: "title", title: "标题", type: "string", required: true, default: "默认标题" },
          { name: "count", title: "数量", type: "integer", required: true },
          { name: "public", title: "公开", type: "boolean", required: false, default: true },
          { name: "channel", title: "渠道", type: "string", required: true, enum: ["stable", "beta"] },
        ],
      },
    });
    expect(host.textContent).toContain("请补充发布信息");
    expect(host.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("默认标题");
    expect(host.querySelector<HTMLInputElement>('input[name="public"]')?.checked).toBe(true);
    inputValue(host.querySelector<HTMLInputElement>('input[name="count"]')!, "3");
    inputValue(host.querySelector<HTMLSelectElement>('select[name="channel"]')!, "beta");
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "提交")?.click());
    expect(onRespond).toHaveBeenCalledWith("el-form", {
      action: "accept",
      content: { title: "默认标题", count: 3, public: true, channel: "beta" },
    });
  });

  it("必填校验失败时不发送，拒绝与取消分别传递不同动作", () => {
    const { host, onRespond } = mount({
      requestId: "el-required", kind: "elicitation",
      elicitation: {
        serverName: "docs", message: "需要名称", mode: "form",
        fields: [{ name: "name", title: "名称", type: "string", required: true }],
      },
    });
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "提交")?.click());
    expect(onRespond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("名称：必填");
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "拒绝")?.click());
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "取消")?.click());
    expect(onRespond).toHaveBeenNthCalledWith(1, "el-required", { action: "decline" });
    expect(onRespond).toHaveBeenNthCalledWith(2, "el-required", { action: "cancel" });
  });

  it("URL 只展示来源，用户确认时才打开完整地址并接受", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const raw = "https://user:pass@example.com/auth?token=secret#next";
    const { host, onRespond } = mount({
      requestId: "el-url", kind: "elicitation",
      elicitation: { serverName: "docs", message: "需要登录", mode: "url", url: raw },
    });
    expect(host.textContent).toContain("example.com");
    expect(host.textContent).not.toContain("token=secret");
    expect(open).not.toHaveBeenCalled();
    act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "打开链接并继续")?.click());
    expect(open).toHaveBeenCalledWith(raw, "_blank", "noopener,noreferrer");
    expect(onRespond).toHaveBeenCalledWith("el-url", { action: "accept" });
  });

  it("结算记录使用 MCP 专用文案、字段名和 URL 完成状态", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const record: InteractionRecord = {
      requestId: "el-record", kind: "elicitation", outcome: "allowed", resolvedAt: 1,
      elicitationAction: "accept", submittedFields: ["name"], elicitationComplete: true,
      elicitation: { serverName: "docs", message: "需要登录", mode: "url", url: "https://example.com/auth" },
    };
    act(() => root.render(<InteractionRecordView record={record} />));
    expect(host.textContent).toContain("MCP 请求：docs");
    expect(host.textContent).toContain("已接受");
    expect(host.textContent).toContain("已提交字段：name");
    expect(host.textContent).toContain("链接流程已完成");
    expect(host.textContent).not.toContain("操作审批");
  });
});
