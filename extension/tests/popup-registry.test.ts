import { describe, it, expect } from "vitest";
import { PopupRegistry } from "../src/lib/popup-registry";

describe("PopupRegistry 弹窗钉住注册表", () => {
  it("登记弹窗后可按页面 tab 找回（同 tab 去重聚焦）", () => {
    const r = new PopupRegistry();
    expect(r.winForTab(10)).toBeNull();
    r.registerPopup(100, 10);
    expect(r.winForTab(10)).toBe(100);
    expect(r.winForTab(11)).toBeNull();
  });

  it("pin 上报：按 tab 查钉住；同一弹窗换绑自动解除旧 tab 并返回旧 tabId", () => {
    const r = new PopupRegistry();
    r.registerPopup(100, 10);
    expect(r.pin({ winId: 100, tabId: 10, aliasName: "笔记", hue: 200 })).toBeNull(); // 全新登记
    expect(r.pinForTab(10)).toMatchObject({ winId: 100, aliasName: "笔记", hue: 200 });
    // 换绑到 tab 20：旧 tab 10 的钉住被解除，返回 10 供摘旧徽标
    expect(r.pin({ winId: 100, tabId: 20, aliasName: "笔记", hue: 200 })).toBe(10);
    expect(r.pinForTab(10)).toBeNull();
    expect(r.pinForTab(20)?.winId).toBe(100);
    // 重复上报同一钉住：无替换
    expect(r.pin({ winId: 100, tabId: 20, aliasName: "改名", hue: 200 })).toBeNull();
    expect(r.pinForTab(20)?.aliasName).toBe("改名");
  });

  it("弹窗窗口被关：清登记与钉住，返回需摘徽标的 tabId", () => {
    const r = new PopupRegistry();
    r.registerPopup(100, 10);
    r.pin({ winId: 100, tabId: 10, aliasName: "笔记", hue: 200 });
    expect(r.windowRemoved(100)).toBe(10);
    expect(r.winForTab(10)).toBeNull();
    expect(r.pinForTab(10)).toBeNull();
    // 未登记的窗口：null，无副作用
    expect(r.windowRemoved(999)).toBeNull();
  });

  it("登记但未 pin 的弹窗被关：无需摘徽标返回 null", () => {
    const r = new PopupRegistry();
    r.registerPopup(100, 10);
    expect(r.windowRemoved(100)).toBeNull();
  });

  it("页面 tab 被关：清钉住与弹窗登记，返回受影响 winId", () => {
    const r = new PopupRegistry();
    r.registerPopup(100, 10);
    r.pin({ winId: 100, tabId: 10, aliasName: "笔记", hue: 200 });
    expect(r.tabRemoved(10)).toBe(100);
    expect(r.pinForTab(10)).toBeNull();
    expect(r.winForTab(10)).toBeNull();
    expect(r.tabRemoved(10)).toBeNull(); // 幂等
  });

  it("多弹窗互不干扰", () => {
    const r = new PopupRegistry();
    r.registerPopup(100, 10);
    r.registerPopup(200, 20);
    r.pin({ winId: 100, tabId: 10, aliasName: "A", hue: 1 });
    r.pin({ winId: 200, tabId: 20, aliasName: "B", hue: 2 });
    r.windowRemoved(100);
    expect(r.winForTab(20)).toBe(200);
    expect(r.pinForTab(20)?.aliasName).toBe("B");
  });
});
