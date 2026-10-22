import { describe, it, expect, vi, afterEach } from "vitest";
import { stripInlineHandlers, snapshotActiveTab } from "../src/lib/page-extract";

describe("stripInlineHandlers", () => {
  it("剥离双引号 / 单引号 / 无引号三种属性值", () => {
    expect(stripInlineHandlers('<img src=x onerror="alert(1)">')).toBe("<img src=x>");
    expect(stripInlineHandlers("<div onclick='a()'>x</div>")).toBe("<div>x</div>");
    expect(stripInlineHandlers("<svg onload=alert(1)></svg>")).toBe("<svg></svg>");
  });

  it("兼容大写属性名、等号两侧空白与换行", () => {
    expect(stripInlineHandlers('<body ONLOAD = "init()">')).toBe("<body>");
    expect(stripInlineHandlers('<img\nonerror="h()">')).toBe("<img>");
    expect(stripInlineHandlers('<img onerror\t=\t"h()">')).toBe("<img>");
  });

  it("同一标签内多个 on* 属性全部剥离", () => {
    expect(stripInlineHandlers('<a href="#" onclick="a()" onmouseover="b()">x</a>')).toBe('<a href="#">x</a>');
  });

  it("普通属性与文本不受影响（data-onclick、@click 等非原生写法保留）", () => {
    const html = '<p class="a" data-onclick="keep" title="on load 说明">基于 on load 的文本</p>';
    expect(stripInlineHandlers(html)).toBe(html);
  });

  it("无 on* 属性时原样返回", () => {
    const html = '<div id="x"><span>plain</span></div>';
    expect(stripInlineHandlers(html)).toBe(html);
  });
});

describe("snapshotActiveTab 扩展自身页面守卫", () => {
  const OWN = "chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno/";

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome; // 拆掉 chrome 桩，避免渗漏到其他测试
  });

  /**
   * 安装 chrome 桩：tabs.query 返回给定 tab，scripting.executeScript 用传入的桩（缺省为空操作的 vi.fn）。
   * @param tab 活动标签页（id 必有；url 缺省模拟 tabs 权限拿不到地址的情形）
   * @param executeScript 自定义注入桩（用于注入成功但页面自报扩展地址的用例）
   * @returns 实际安装的 executeScript 桩（便于断言是否被调用）
   */
  function stubChrome(tab: { id: number; url?: string }, executeScript?: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
    const exec = executeScript ?? vi.fn();
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { getURL: (p: string) => OWN + p },
      tabs: { query: vi.fn(async () => [tab]) },
      scripting: { executeScript: exec },
    };
    return exec;
  }

  it("活动 tab 是扩展自身页面（sidepanel 被开成标签页）时不注入、不附带", async () => {
    const exec = stubChrome({ id: 1, url: `${OWN}sidepanel.html` });
    const r = await snapshotActiveTab();
    expect(r.page).toBeNull();
    expect(r.error).toContain("扩展");
    expect(exec).not.toHaveBeenCalled();
  });

  it("tabs 查询拿不到 url 时，注入后用页面自报的 location.href 再挡一次", async () => {
    stubChrome({ id: 1 }, vi.fn(async () => [{ result: { html: "<html><body>chat</body></html>", url: `${OWN}sidepanel.html`, title: "侧栏", selection: "" } }]));
    const r = await snapshotActiveTab();
    expect(r.page).toBeNull();
    expect(r.error).toContain("扩展");
  });
});
