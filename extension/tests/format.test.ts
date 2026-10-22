import { describe, it, expect } from "vitest";
import { shortModelName, isWebHref } from "../src/lib/format";

describe("shortModelName", () => {
  it("标准 claude- 前缀 ID 压短并转版本号", () => {
    expect(shortModelName("claude-fable-5-1")).toBe("fable 5.1");
    expect(shortModelName("claude-opus-4-5")).toBe("opus 4.5");
  });

  it("带日期后缀的旧版 ID 先去日期再压短", () => {
    expect(shortModelName("claude-sonnet-4-5-20250929")).toBe("sonnet 4.5");
  });

  it("别名与不认识的格式（如中转自定义 ID）原样返回", () => {
    expect(shortModelName("fable")).toBe("fable");
    expect(shortModelName("my-relay-model")).toBe("my-relay-model");
  });
});

describe("isWebHref", () => {
  it("http/https 绝对地址可打开", () => {
    expect(isWebHref("https://example.com/a?b=1")).toBe(true);
    expect(isWebHref("http://127.0.0.1:19280/")).toBe(true);
  });

  it("本地文件名等相对地址不可打开（防解析成扩展内部地址）", () => {
    expect(isWebHref("标准知识.md")).toBe(false);
    expect(isWebHref("./docs/a.md")).toBe(false);
    expect(isWebHref("/abs/path")).toBe(false);
  });

  it("非 http 协议与空串一律不可打开", () => {
    expect(isWebHref("chrome-extension://cnalihjaacpahpjkpneacjcfbhboglno/sidepanel.html")).toBe(false);
    expect(isWebHref("file:///D:/a.md")).toBe(false);
    expect(isWebHref("javascript:alert(1)")).toBe(false);
    expect(isWebHref("mailto:a@b.c")).toBe(false);
    expect(isWebHref("")).toBe(false);
  });
});
