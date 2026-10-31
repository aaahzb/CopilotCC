/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskCard } from "../src/components/AskCard";
import type { AskRequest } from "../src/lib/protocol";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/** 挂载真实提问卡片并返回 DOM 与作答回调。 */
function mount(request: AskRequest | null): { host: HTMLDivElement; onRespond: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onRespond = vi.fn();
  act(() => root.render(<AskCard request={request} onRespond={onRespond} />));
  return { host, onRespond };
}

/** 触发真实 DOM 点击并刷新 React 状态。 */
function click(element: Element): void {
  act(() => (element as HTMLElement).click());
}

/** 按选项值找单选/复选输入，避免依赖选项排列位置。 */
function option(host: HTMLElement, value: string): HTMLInputElement {
  const input = Array.from(host.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]"))
    .find((el) => el.value === value);
  if (!input) throw new Error(`找不到选项：${value}`);
  return input;
}

/** 向 Other 自由文本框输入内容。 */
function typeOther(host: HTMLElement, value: string): void {
  const input = host.querySelector<HTMLInputElement>('input[placeholder="输入自定义回答"]');
  if (!input) throw new Error("Other 文本框未出现");
  act(() => {
    // 绕过 React 的 value tracker，模拟浏览器原生输入后再派发 input
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 取得提交按钮。 */
function submitButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error("找不到提交按钮");
  return button;
}

const singleRequest: AskRequest = {
  requestId: "ask-1",
  questions: [{
    question: "你想用哪个方案？",
    header: "方案",
    options: [{ label: "方案 A", description: "改动较小" }, { label: "方案 B" }],
    multiSelect: false,
  }],
};

describe("AskCard 提问卡片", () => {
  it("无挂起提问时不渲染；有提问时显示问题、选项与说明", () => {
    expect(mount(null).host.innerHTML).toBe("");
    const { host } = mount(singleRequest);
    expect(host.textContent).toContain("你想用哪个方案？");
    expect(host.textContent).toContain("方案");
    expect(host.textContent).toContain("改动较小");
    expect(host.textContent).toContain("其他（自定义）");
  });

  it("CLI 提供的 preview 默认折叠且可完整展开", () => {
    const { host } = mount({
      requestId: "ask-preview",
      questions: [{
        question: "看预览", header: "预览", multiSelect: false,
        options: [{ label: "方案 A", description: "说明", preview: "第一行\n第二行" }],
      }],
    });
    const preview = host.querySelector<HTMLDetailsElement>("details.ask-preview");
    expect(preview?.open).toBe(false);
    expect(preview?.textContent).toContain("第一行\n第二行");
    click(preview!.querySelector("summary")!);
    expect(preview?.open).toBe(true);
  });

  it("单选提交后以问题文本为键回填所选 label", () => {
    const { host, onRespond } = mount(singleRequest);
    click(option(host, "方案 A"));
    click(submitButton(host));
    expect(onRespond).toHaveBeenCalledWith("ask-1", { "你想用哪个方案？": "方案 A" });
  });

  it("多选按选择顺序用逗号空格连接答案", () => {
    const { host, onRespond } = mount({
      requestId: "ask-2",
      questions: [{ question: "包含哪些能力？", header: "能力", options: [{ label: "搜索" }, { label: "测试" }, { label: "构建" }], multiSelect: true }],
    });
    click(option(host, "测试"));
    click(option(host, "搜索"));
    click(submitButton(host));
    expect(onRespond).toHaveBeenCalledWith("ask-2", { "包含哪些能力？": "测试, 搜索" });
  });

  it("Other 展开自由文本并提交去除首尾空白的自定义答案", () => {
    const { host, onRespond } = mount(singleRequest);
    click(option(host, "__other__"));
    expect(submitButton(host).disabled).toBe(true);
    typeOther(host, "  自定义方案  ");
    expect(submitButton(host).disabled).toBe(false);
    click(submitButton(host));
    expect(onRespond).toHaveBeenCalledWith("ask-1", { "你想用哪个方案？": "自定义方案" });
  });

  it("多选可同时包含预置选项与 Other 自定义答案", () => {
    const { host, onRespond } = mount({
      requestId: "ask-3",
      questions: [{ question: "选择范围", header: "范围", options: [{ label: "前端" }], multiSelect: true }],
    });
    click(option(host, "前端"));
    click(option(host, "__other__"));
    typeOther(host, "文档");
    click(submitButton(host));
    expect(onRespond).toHaveBeenCalledWith("ask-3", { "选择范围": "前端, 文档" });
  });

  it("多问题必须全部作答，答案分别按完整问题文本归档", () => {
    const { host, onRespond } = mount({
      requestId: "ask-4",
      questions: [
        { question: "第一题", header: "一", options: [{ label: "甲" }], multiSelect: false },
        { question: "第二题", header: "二", options: [{ label: "乙" }], multiSelect: false },
      ],
    });
    expect(submitButton(host).disabled).toBe(true);
    click(option(host, "甲"));
    expect(submitButton(host).disabled).toBe(true);
    click(option(host, "乙"));
    expect(submitButton(host).disabled).toBe(false);
    click(submitButton(host));
    expect(onRespond).toHaveBeenCalledWith("ask-4", { "第一题": "甲", "第二题": "乙" });
  });
});
