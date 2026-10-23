import { describe, it, expect } from "vitest";
import { parsePopupMode, popupUrl } from "../src/lib/popup-mode";

describe("parsePopupMode 弹窗参数解析", () => {
  it("完整参数：popup=1&tab=42&alias=a1", () => {
    expect(parsePopupMode("?popup=1&tab=42&alias=a1")).toEqual({ popup: true, tabId: 42, aliasId: "a1" });
  });

  it("无 alias：aliasId 为 null 仍算弹窗", () => {
    expect(parsePopupMode("?popup=1&tab=42")).toEqual({ popup: true, tabId: 42, aliasId: null });
  });

  it("缺 tab 或 tab 非法：popup=1 也按侧边栏处理（防无钉漂浮窗）", () => {
    expect(parsePopupMode("?popup=1").popup).toBe(false);
    expect(parsePopupMode("?popup=1&tab=abc").popup).toBe(false);
    expect(parsePopupMode("?popup=1&tab=0").popup).toBe(false);
    expect(parsePopupMode("?popup=1&tab=-3").popup).toBe(false);
  });

  it("无 popup 参数：普通侧边栏", () => {
    expect(parsePopupMode("")).toEqual({ popup: false, tabId: null, aliasId: null });
    expect(parsePopupMode("?tab=42")).toEqual({ popup: false, tabId: 42, aliasId: null });
  });

  it("alias 空串视为未指定", () => {
    expect(parsePopupMode("?popup=1&tab=42&alias=").aliasId).toBeNull();
  });
});

describe("popupUrl 构造", () => {
  it("带别名", () => {
    expect(popupUrl(42, "a1")).toBe("sidepanel.html?popup=1&tab=42&alias=a1");
  });

  it("不带别名", () => {
    expect(popupUrl(42)).toBe("sidepanel.html?popup=1&tab=42");
  });

  it("别名含特殊字符被正确编码且可回读", () => {
    const u = popupUrl(7, "别名/甲");
    expect(parsePopupMode(u.slice(u.indexOf("?")))).toEqual({ popup: true, tabId: 7, aliasId: "别名/甲" });
  });
});
