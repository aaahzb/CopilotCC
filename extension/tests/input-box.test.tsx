/** @vitest-environment jsdom */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBox } from "../src/components/InputBox";

const base: React.ComponentProps<typeof InputBox> = {
  disabled: false,
  busy: false,
  attachEnabled: true,
  permissionMode: "auto",
  model: "fable",
  effort: "high",
  effectiveModel: "opus 5.5",
  effectiveEffort: null,
  fastMode: true,
  fastRuntime: { state: "on" },
  forceAttach: false,
  onToggleForceAttach: () => {},
  onToggleAttach: () => {},
  onModeChange: () => {},
  onModelChange: () => {},
  onEffortChange: () => {},
  onFastModeChange: () => {},
  draft: "",
  onDraftChange: () => {},
  onSend: () => {},
  onStop: () => {},
};

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/** 挂载真实 DOM，验证用户点击而不是仅检查静态标记。 */
function mount(patch: Partial<React.ComponentProps<typeof InputBox>> = {}): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<InputBox {...base} {...patch} />));
  return host;
}

/** 在 act 中派发真实点击，确保 React 更新已刷新后再断言。 */
function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function render(patch: Partial<React.ComponentProps<typeof InputBox>> = {}): string {
  return renderToStaticMarkup(<InputBox {...base} {...patch} />);
}

/** 只取发送行的实际值指示，避免下拉中的请求模型选项干扰断言。 */
function hintOf(html: string): string {
  return html.match(/<button[^>]*class="model-effort"[^>]*>([^<]*)<\/button>/)?.[1] ?? "";
}

describe("InputBox 原生 fast 与实际执行状态", () => {
  it("CC 实际模型优先，effort=null 不回退成请求值 high", () => {
    const html = render();
    expect(hintOf(html)).toBe("opus 5.5");
    expect(html).toContain("fast on");
    expect(html).toContain("CC fast on");
  });

  it("冷却期与禁用原因来自 CC，设置错误显示在设置区", () => {
    const html = render({ fastRuntime: { state: "cooldown", disabledReason: "network_error" }, settingsError: "native denied" });
    expect(html).toContain("冷却中（cooldown）");
    expect(html).toContain("网络错误");
    expect(html).toContain('role="alert"');
    expect(html).toContain("native denied");
  });

  it("等待真值时不伪造 on，busy 中仍显示真正的停止按钮", () => {
    const html = render({ busy: true, fastMode: false, fastRuntime: undefined });
    expect(html).toContain("fast off");
    expect(html).toContain("等待 CC 回报");
    expect(html).toContain("■ 停止");
  });

  it("执行选项保持单行，effort 入口与 fast 真值位于下方状态组", () => {
    const host = mount();
    const toggles = host.querySelector(".toggles")!;
    expect(toggles.querySelectorAll("select")).toHaveLength(2);
    expect(toggles.textContent).not.toContain("CC fast");
    const status = host.querySelector(".execution-status")!;
    expect(status.querySelector(".model-effort")?.textContent).toBe("opus 5.5");
    expect(status.querySelector(".fast-runtime")?.textContent).toBe("(CC fast on)");
    const css = readFileSync("src/entrypoints/sidepanel/style.css", "utf8");
    const togglesRule = css.split(".input-box .toggles")[1]?.split("}")[0] ?? "";
    expect(togglesRule.replaceAll(" ", "")).toContain("flex-wrap:nowrap");
  });

  it("点击模型状态展开 effort，选择后回调并关闭", () => {
    const onEffortChange = vi.fn();
    const host = mount({ onEffortChange });
    click(host.querySelector(".model-effort")!);
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    click(host.querySelector('[data-effort="medium"]')!);
    expect(onEffortChange).toHaveBeenCalledWith("medium");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it("点击状态组外部关闭 effort 弹层", () => {
    const host = mount();
    click(host.querySelector(".model-effort")!);
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it("Escape 关闭 effort 弹层且不触发停止", () => {
    const onStop = vi.fn();
    const host = mount({ busy: true, onStop });
    click(host.querySelector(".model-effort")!);
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("模型下拉仍只发送模型变更", () => {
    const onModelChange = vi.fn();
    const host = mount({ onModelChange });
    const select = host.querySelector('select[title^="模型"]')!;
    act(() => {
      (select as HTMLSelectElement).value = "sonnet";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onModelChange).toHaveBeenCalledWith("sonnet");
  });

  it("自动档实际值未知时仍显示可点击的自动入口", () => {
    const host = mount({ model: "", effort: "", effectiveModel: undefined, effectiveEffort: undefined });
    expect(host.querySelector("button.model-effort")?.textContent).toBe("自动");
  });
});
