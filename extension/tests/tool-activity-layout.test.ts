import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/entrypoints/sidepanel/style.css", import.meta.url),
  "utf8",
);

/** 读取单条 CSS 规则正文，避免把后续同名选择器误判为工具行自身。 */
function ruleBody(selector: string): string {
  const selectorStart = css.indexOf(`${selector} {`);
  if (selectorStart < 0) throw new Error(`缺少 CSS 规则: ${selector}`);
  const open = css.indexOf("{", selectorStart);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("工具活动行真实布局约束", () => {
  it("长会话溢出时禁止被纵向 flex 收缩为零高度", () => {
    expect(ruleBody(".message-list")).toMatch(/flex-direction:\s*column/);
    expect(ruleBody(".tool-activity")).toMatch(/flex-shrink:\s*0\s*;/);
  });
});
