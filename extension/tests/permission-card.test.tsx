/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionCard } from "../src/components/PermissionCard";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/** 挂载权限卡；额外字段模拟新版桥接协议，旧实现应暴露缺失行为。 */
function mount(request: {
  requestId: string;
  tool: string;
  detail: string;
  kind?: "permission" | "exit_plan";
  summary?: string;
  plan?: string;
  planFilePath?: string;
}): { host: HTMLDivElement; onRespond: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onRespond = vi.fn();
  act(() => root.render(
    <PermissionCard request={{ ...request, kind: request.kind ?? "permission" }} onRespond={onRespond} />,
  ));
  return { host, onRespond };
}

/** 输入计划退回意见并触发 React 受控更新。 */
function typeFeedback(host: HTMLElement, value: string): void {
  const input = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) throw new Error("找不到计划退回意见输入框");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PermissionCard 中文审批与计划卡", () => {
  it("普通权限显示中文摘要，原始参数默认折叠", () => {
    const { host } = mount({
      requestId: "perm-read", tool: "Read", summary: "读取文件：notes.txt",
      detail: '{\n  "file_path": "notes.txt"\n}',
    });
    expect(host.textContent).toContain("读取文件：notes.txt");
    const detail = host.querySelector<HTMLDetailsElement>("details.permission-detail");
    expect(detail?.open).toBe(false);
    expect(detail?.textContent).toContain('"file_path": "notes.txt"');
  });

  it("退出计划显示完整计划、文件路径和批准按钮", () => {
    const plan = "# 实施计划\n\n1. 保留完整内容\n2. 自动验证";
    const { host, onRespond } = mount({
      requestId: "perm-plan", tool: "ExitPlanMode", kind: "exit_plan", detail: "{}",
      summary: "申请批准计划并继续执行", plan, planFilePath: "D:\\plans\\demo.md",
    });
    expect(host.textContent).toContain("申请批准计划并继续执行");
    expect(host.textContent).toContain("D:\\plans\\demo.md");
    const detail = host.querySelector<HTMLDetailsElement>("details.plan-detail");
    expect(detail?.open).toBe(false);
    expect(detail?.textContent).toContain(plan);
    act(() => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "批准并继续")?.click());
    expect(onRespond).toHaveBeenCalledWith("perm-plan", true, undefined);
  });

  it("继续修改可携带退回意见，并原样交给桥接", () => {
    const { host, onRespond } = mount({
      requestId: "perm-plan", tool: "ExitPlanMode", kind: "exit_plan", detail: "{}", plan: "旧计划",
    });
    typeFeedback(host, "  请补充浏览器验收  ");
    act(() => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "继续修改")?.click());
    expect(onRespond).toHaveBeenCalledWith("perm-plan", false, "请补充浏览器验收");
  });
});
