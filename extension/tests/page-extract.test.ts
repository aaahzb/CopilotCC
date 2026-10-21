import { describe, it, expect } from "vitest";
import { stripInlineHandlers } from "../src/lib/page-extract";

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
