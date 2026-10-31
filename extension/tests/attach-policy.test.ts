import { describe, it, expect } from "vitest";
import { decideAttach, composeMessage, MAX_PAGE_CHARS, PAGE_RICHNESS_CAPS, type PageSnapshot, deriveAttachKind } from "../src/lib/attach-policy";

const page: PageSnapshot = { url: "https://a.com/x", title: "标题", markdown: "正文内容", selection: "选中片段" };

describe("decideAttach", () => {
  it("首次 / 换页 / 同页 / 关闭 四种分支", () => {
    expect(decideAttach(null, "https://a.com/x", true)).toEqual({ attachFull: true, reason: "first" });
    expect(decideAttach("https://a.com/old", "https://a.com/x", true)).toEqual({ attachFull: true, reason: "url-changed" });
    expect(decideAttach("https://a.com/x", "https://a.com/x", true)).toEqual({ attachFull: false, reason: "same-url" });
    expect(decideAttach(null, "https://a.com/x", false)).toEqual({ attachFull: false, reason: "disabled" });
  });
});

describe("composeMessage", () => {
  it("带全文+选中+问题", () => {
    const out = composeMessage("这页讲了什么", page, true);
    expect(out).toContain("[页面上下文 url=https://a.com/x 标题=标题]");
    expect(out).toContain("正文内容");
    expect(out).toContain("[选中文字]\n选中片段");
    expect(out).toContain("[用户问题]\n这页讲了什么");
  });

  it("同页不带全文但仍带选中", () => {
    const out = composeMessage("这段话什么意思", page, false);
    expect(out).not.toContain("[页面上下文");
    expect(out).toContain("[选中文字]");
  });

  it("无页面（提取失败）只发问题", () => {
    expect(composeMessage("你好", null, false)).toBe("[用户问题]\n你好");
  });

  it("CLI 斜杠命令即使有页面上下文也保持原文", () => {
    expect(composeMessage("/compact", page, true)).toBe("/compact");
    expect(composeMessage("/model opus", null, false)).toBe("/model opus");
  });

  it("超长正文截断到 MAX_PAGE_CHARS", () => {
    const big: PageSnapshot = { ...page, markdown: "x".repeat(MAX_PAGE_CHARS + 100), selection: "" };
    const out = composeMessage("q", big, true);
    expect(out.length).toBeLessThan(MAX_PAGE_CHARS + 500);
  });

  it("丰富度档位决定截断上限：精简 5 千 / 标准 3 万（缺省）/ 丰富 10 万", () => {
    const big: PageSnapshot = { ...page, markdown: "x".repeat(120_000), selection: "" };
    const brief = composeMessage("q", big, true, "brief");
    expect(brief).toContain("[页面上下文");
    expect(brief.length).toBeLessThan(PAGE_RICHNESS_CAPS.brief + 500);
    const rich = composeMessage("q", big, true, "rich");
    expect(rich.length).toBeGreaterThan(MAX_PAGE_CHARS); // 丰富档放行了超过标准档的内容
    expect(rich.length).toBeLessThan(PAGE_RICHNESS_CAPS.rich + 500);
  });
});

describe("deriveAttachKind 附带标记反推", () => {
  it("优先级：上传 > 全文 > 选中（与转录回放一致）", () => {
    expect(deriveAttachKind("[上传文件] 用户上传了 1 个文件\n\n[页面上下文 url=x]\n正文")).toBe("upload");
    expect(deriveAttachKind("[页面上下文 url=x 标题=t]\n正文\n\n[用户问题]\nq")).toBe("full");
    expect(deriveAttachKind("[选中文字]\n片段\n\n[用户问题]\nq")).toBe("selection");
  });

  it("未附带（纯问题）返回 undefined", () => {
    expect(deriveAttachKind("[用户问题]\n你好")).toBeUndefined();
  });
});
