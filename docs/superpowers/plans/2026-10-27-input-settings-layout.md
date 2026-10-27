# CopilotCC 输入区单行与合并 effort 入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 执行选项始终保持单行，模型仍在上方选择，effort 改由下方模型状态按钮展开，CC fast 真值紧跟其右。

**Architecture:** 只改 `InputBox` 的本地展示与展开状态，继续复用 App 的 `onModelChange`、`onEffortChange` 和 `onFastModeChange`。上方删除 effort 下拉与 fast 真值，下方用状态组承载模型按钮、effort 弹层和 fast 真值；桥接与协议完全不动。

**Tech Stack:** React 19、TypeScript、Vitest、jsdom、WXT、现有 CSS。

## Global Constraints

- 遵循已批准的 `docs/superpowers/specs/2026-10-27-input-settings-layout-design.md`。
- 测试先行，每个新行为先观察预期 RED，再写最小实现。
- 不改变请求值与 CC 真值的边界，不改变 busy、草稿、上传、停止和设置消息。
- `effectiveEffort=null` 不回退请求值；fast 冷却、禁用原因和 pending 文案不丢失。
- 不修改桥接源码，不重建桥接 exe，不引入官方登录。
- 修改仅限本计划文件、已批准产品文件、测试、文档和扩展产物；不删除文件，不 commit、push、tag 或发布。

---

### Task 1：DOM 测试环境与布局、交互 RED

**Files:**
- Modify: `extension/package.json`、`extension/package-lock.json`
- Modify: `extension/tsconfig.json`
- Modify: `extension/tests/input-box.test.tsx`
- Test: `extension/tests/input-box.test.tsx`

**Interfaces:**
- Consumes: 现有 `InputBox` props 与 `base` 测试夹具。
- Produces: `mount(patch)`、`click(element)` 测试辅助函数，以及针对新界面行为的失败断言。

- [x] **Step 1：安装仅用于测试的 DOM 环境**

```bash
cd /d/SVN_Cursor/chromeClaudeCode/extension
npm install --save-dev jsdom @types/node --registry=https://registry.npmmirror.com
```

预期：`package.json` 与 lockfile 只增加 jsdom、Node 类型及其测试依赖树，React、WXT 和协议复制件不变。

把 `extension/tsconfig.json` 的 `compilerOptions.types` 改为 `["chrome", "node"]`，供测试中的 `node:fs` 通过严格类型检查。

- [x] **Step 2：把输入区测试切到 jsdom 并加入真实 DOM 挂载辅助**

在文件首行加入 `/** @vitest-environment jsdom */`，保留现有 SSR 测试，并加入：

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, vi } from "vitest";

const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});
function mount(patch: Partial<React.ComponentProps<typeof InputBox>> = {}): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<InputBox {...base} {...patch} />));
  return host;
}
function click(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
```

把 `hintOf` 的匹配目标从 `span.model-effort` 改为 `button.model-effort`，保持现有 `effectiveEffort=null` 断言不变。

- [x] **Step 3：写入新界面失败测试**

```tsx
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
```

- [x] **Step 4：运行测试并确认 RED 原因正确**

```bash
cd /d/SVN_Cursor/chromeClaudeCode/extension
npx vitest run tests/input-box.test.tsx
```

预期：新测试因上方仍有第三个 select、缺少 `.execution-status`、模型状态仍不是按钮、CSS 仍为 `flex-wrap:wrap` 而失败；不是 jsdom 安装或测试挂载错误。既有 fast 回调测试继续通过。

### Task 2：单行布局、底部 fast 真值与 effort 弹层 GREEN

**Files:**
- Modify: `extension/src/components/InputBox.tsx`
- Modify: `extension/src/entrypoints/sidepanel/style.css`
- Test: `extension/tests/input-box.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 DOM 测试与现有 props。
- Produces: `.execution-status`、`button.model-effort`、`.fast-runtime`、`.effort-picker`；不改变任何对外 props。

- [x] **Step 1：先补自动档真值未到时的入口 RED**

```tsx
it("自动档实际值未知时仍显示可点击的自动入口", () => {
  const host = mount({ model: "", effort: "", effectiveModel: undefined, effectiveEffort: undefined });
  expect(host.querySelector("button.model-effort")?.textContent).toBe("自动");
});
```

运行 `npx vitest run tests/input-box.test.tsx`，确认它因缺少该按钮失败，再开始产品实现。

- [x] **Step 2：加入弹层本地状态和关闭监听**

把 React 导入改为 `import React, { useEffect, useRef, useState } from "react";`，在 `InputBox` 内加入：

```tsx
const [effortOpen, setEffortOpen] = useState(false);
const effortStatusRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (!effortOpen) return;
  const onOutside = (event: MouseEvent): void => {
    if (!effortStatusRef.current?.contains(event.target as Node | null)) setEffortOpen(false);
  };
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") setEffortOpen(false);
  };
  document.addEventListener("mousedown", onOutside);
  document.addEventListener("keydown", onEscape);
  return () => {
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onEscape);
  };
}, [effortOpen]);
```

删除 `.toggles` 中的 `span.fast-runtime` 和整个 effort `select`，保留 fast 开关、权限 select 和模型 select。不要改它们的 `onChange`。

- [x] **Step 3：用状态组替换发送行左侧的只读 span**

```tsx
<div className="execution-status" ref={effortStatusRef}>
  <button
    type="button"
    className="model-effort"
    aria-label={`当前 ${hint || "自动"}，点击修改 effort`}
    aria-haspopup="listbox"
    aria-expanded={effortOpen}
    title={`${modelPending || effortPending ? "当前显示请求值，等待 CC 回报实际模型/effort" : "CC 最近回报的实际模型与推理强度"}；点击修改 effort`}
    onClick={() => setEffortOpen((open) => !open)}
  >{hint || "自动"}</button>
  <span className={`fast-runtime ${props.fastRuntime?.state ?? "pending"}`} title={fastTitle} aria-live="polite">
    {`(${fastStatusText(props.fastRuntime)})`}
  </span>
  {effortOpen ? (
    <div className="effort-picker" role="listbox" aria-label="选择 effort">
      {(["", "low", "medium", "high", "xhigh", "max"] as Array<EffortLevelSetting | "">).map((value) => (
        <button
          key={value || "auto"}
          type="button"
          role="option"
          aria-selected={props.effort === value}
          data-effort={value}
          onClick={() => {
            setEffortOpen(false);
            props.onEffortChange(value);
          }}
        >
          {value || (props.effectiveEffort === null
            ? "自动 · 未下发 effort"
            : props.effectiveEffort
              ? `自动 · ${props.effectiveEffort}`
              : "自动（跟随 CLI 配置）")}
        </button>
      ))}
    </div>
  ) : null}
</div>
```

- [x] **Step 4：替换布局与状态样式**

```css
.input-box .toggles { display: flex; flex-wrap: nowrap; overflow: hidden; min-width: 0; gap: 6px 8px; align-items: center; font-size: 12px; color: #9aa0a6; }
.input-box .toggles > select { flex: 1 1 6rem; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.input-box .fast-runtime { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.input-box .fast-runtime.on { color: #81c995; }
.input-box .fast-runtime.cooldown { color: #fdd663; }
.input-box .fast-runtime.pending { color: #9aa0a6; }
.input-box .send-row .execution-status { position: relative; display: flex; align-items: center; gap: 4px; flex: 1 1 8rem; min-width: 4.5em; max-width: 100%; }
.input-box .send-row .model-effort { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; padding: 0; background: none; color: #9aa0a6; opacity: 0.85; cursor: pointer; font-size: 11px; }
.input-box .send-row .model-effort::after { content: " ▾"; }
.input-box .send-row .effort-picker { position: absolute; left: 0; bottom: calc(100% + 4px); z-index: 20; display: flex; flex-direction: column; min-width: 10rem; padding: 4px; border: 1px solid #555; border-radius: 6px; background: #24252b; box-shadow: 0 6px 20px #0008; }
.input-box .send-row .effort-picker button { padding: 5px 8px; text-align: left; background: transparent; color: #e4e6eb; }
.input-box .send-row .effort-picker button[aria-selected="true"] { background: #2f4f7f; }
```

删除旧的 `.toggles .fast-runtime` 三条颜色和旧 `.send-row .model-effort` 只读 span 规则，避免同名字段互相覆盖。保留 send-row 的强制看页面、上传、发送与停止样式。

- [x] **Step 5：运行目标测试与完整扩展回归**

```bash
cd /d/SVN_Cursor/chromeClaudeCode/extension
npx vitest run tests/input-box.test.tsx
npm test
npm run typecheck
```

预期：输入区目标测试和全部既有测试通过，类型检查无错误；失败时只修本任务代码，不放宽真值断言。

### Task 3：文档与扩展分发验证

**Files:**
- Modify: `README.md`、`TODO.md`
- Generated: `extension/.output/chrome-mv3/**`、`extension/.output/ccc-extension-0.1.0-chrome.zip`

- [x] **Step 1：同步文档**

README 的“模型与 effort”改为：上方执行行只保留模型下拉且始终单行；下方模型与 effort 文本是 effort 入口，CC fast 真值显示在其右侧。保留现有实际值、自动档和设置重建语义。“原生 fast off/on”的“旁边”改为“下方模型状态右侧”。

TODO 新增 2026-10-27 小节，记录本次用户排版约束、推荐交互、RED/GREEN 结果、实际测试数和构建结果。不得把 Chrome 视觉验收标为已完成。

- [x] **Step 2：构建并核对扩展 zip**

```bash
cd /d/SVN_Cursor/chromeClaudeCode/extension
npm run build
npm run zip
archive=.output/ccc-extension-0.1.0-chrome.zip
unzip -t "$archive"
unzip -Z1 "$archive" | while IFS= read -r entry; do
  case "$entry" in */) continue ;; esac
  cmp ".output/chrome-mv3/$entry" <(unzip -p "$archive" "$entry")
done
cd /d/SVN_Cursor/chromeClaudeCode
git diff --check
```

预期：build 和 zip 成功，zip 无损坏，所有文件条目与构建目录逐字节一致，差异检查无空白错误。既有大 chunk 警告可以保留，但不得隐藏新增错误。

- [x] **Step 3：交付且保留手动验收边界**

报告上方执行选项单行、下方 effort 入口和 fast 真值位置，列出自动测试数、类型检查、build 与 zip 结果。提供新扩展 zip 路径，请用户在 Chrome 验收窄侧栏与独立弹窗。不要重建桥接 exe，不要 commit、push、tag 或发布。
