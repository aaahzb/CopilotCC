/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MessageList, type UiMsg } from "../src/components/MessageList";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/** 挂载消息列表，验证真实 DOM 类和文本，而不是仅测试图标查表。 */
function mount(messages: UiMsg[]): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<MessageList messages={messages} streaming={null} />));
  return host;
}

/** 构造工具活动消息；sentText 不属于工具调用，避免误走附带状态分支。 */
function tool(id: string, toolName: string, text = "摘要"): UiMsg {
  return { id, role: "tool", toolName, text };
}

describe("MessageList 工具活动行", () => {
  it("WebSearch 使用放大镜和独立活动行，不混入回答正文气泡", () => {
    const host = mount([
      tool("search", "WebSearch", "CopilotCC native fast"),
      { id: "answer", role: "assistant", text: "这是回答正文" },
    ]);
    const activity = host.querySelector(".tool-activity");
    expect(activity).not.toBeNull();
    expect(activity?.classList.contains("msg")).toBe(false);
    expect(activity?.classList.contains("assistant")).toBe(false);
    expect(activity?.getAttribute("title")).toBe("WebSearch: CopilotCC native fast");
    expect(activity?.querySelector(".tool-icon")?.textContent).toBe("🔍");
    expect(activity?.querySelector(".tool-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(activity?.querySelector(".tool-name")?.textContent).toBe("WebSearch");
    expect(activity?.querySelector(".tool-summary")?.textContent).toBe("CopilotCC native fast");
    expect(host.querySelector(".msg.assistant")?.textContent).toContain("这是回答正文");
  });

  it("常用工具、MCP 和未知工具使用各自图标与通用回退", () => {
    const cases: Array<[string, string]> = [
      ["WebSearch", "🔍"], ["WebFetch", "🌐"], ["Read", "📄"],
      ["Edit", "✏️"], ["MultiEdit", "✏️"], ["Write", "📝"],
      ["Bash", "💻"], ["Grep", "🔎"], ["Glob", "📁"], ["upload", "📁"],
      ["mcp__tavily__tavily_search", "🔍"], ["mcp__tavily__tavily_extract", "🌐"],
      ["FutureTool", "🔧"],
    ];
    const host = mount(cases.map(([name], index) => tool(`tool-${index}`, name)));
    for (const [name, icon] of cases) {
      expect(host.querySelector(`[data-tool="${name}"] .tool-icon`)?.textContent, name).toBe(icon);
    }
  });

  it("工具活动 CSS 保持单行并省略长摘要", () => {
    const css = readFileSync("src/entrypoints/sidepanel/style.css", "utf8");
    const activityRule = css.split(".tool-activity {")[1]?.split("}")[0] ?? "";
    const summaryRule = css.split(".tool-activity .tool-summary")[1]?.split("}")[0] ?? "";
    expect(activityRule.replaceAll(" ", "")).toContain("white-space:nowrap");
    expect(activityRule.replaceAll(" ", "")).toContain("background:transparent");
    expect(summaryRule.replaceAll(" ", "")).toContain("text-overflow:ellipsis");
  });

  it("前插更早历史后保持原滚动位置，不因用户消息数增加而贴底", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const latest: UiMsg[] = [
      { id: "m-3", role: "user", text: "问题 3" },
      { id: "m-4", role: "assistant", text: "回答 4" },
    ];
    act(() => root.render(<MessageList messages={latest} streaming={null} hasOlderHistory loadingOlder={false} onLoadOlder={() => {}} />));
    const list = host.querySelector<HTMLDivElement>(".message-list")!;
    let scrollHeight = 1000;
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
    list.scrollTop = 400;
    act(() => list.dispatchEvent(new Event("scroll")));
    act(() => host.querySelector<HTMLButtonElement>(".history-more")!.click());
    scrollHeight = 1400;
    const withOlder: UiMsg[] = [
      { id: "m-1", role: "user", text: "问题 1" },
      { id: "m-2", role: "assistant", text: "回答 2" },
      ...latest,
    ];
    act(() => root.render(<MessageList messages={withOlder} streaming={null} hasOlderHistory={false} loadingOlder={false} onLoadOlder={() => {}} />));
    expect(list.scrollTop).toBe(800);
    act(() => root.render(<MessageList messages={withOlder} streaming="继续生成" hasOlderHistory={false} loadingOlder={false} onLoadOlder={() => {}} />));
    expect(list.scrollTop).toBe(800);
  });

  it("Task 状态直接显示，完整子代理报告默认折叠且可展开", () => {
    const report = "## 调查结果\n\n完整子代理报告，不是用户发言。";
    const host = mount([{
      id: "task-long", role: "tool", text: "任务已完成：task-long", detail: report,
    }]);
    const card = host.querySelector(".tool-card")!;
    const details = card.querySelector<HTMLDetailsElement>("details.status-detail")!;
    expect(card.textContent).toContain("任务已完成：task-long");
    expect(host.querySelector(".msg.user")).toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")?.textContent).toBe(report);
    act(() => { details.open = true; });
    expect(details.open).toBe(true);
  });
});
