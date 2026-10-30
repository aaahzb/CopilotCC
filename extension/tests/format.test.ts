import { describe, it, expect } from "vitest";
import { shortModelName, isWebHref, fastStatusText, fastDisabledReasonText, compactRecordText } from "../src/lib/format";

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


describe("原生 fast 状态文案", () => {
  it("区分等待回报、on、off 和原生冷却期", () => {
    expect(fastStatusText(undefined)).toBe("等待 CC 回报");
    expect(fastStatusText({ state: "on" })).toBe("CC fast on");
    expect(fastStatusText({ state: "off" })).toBe("CC fast off");
    expect(fastStatusText({ state: "cooldown" })).toBe("冷却中（cooldown）");
  });

  it("禁用原因使用可读文案，不把请求开关当成实际生效", () => {
    expect(fastDisabledReasonText("model_not_allowed")).toContain("当前模型");
    expect(fastDisabledReasonText("not_first_party")).toContain("第一方");
    expect(fastDisabledReasonText("network_error")).toContain("网络");
  });
});

describe("compactRecordText", () => {
  it("成功且有元数据：真实压缩率（156000→42000 = -73%）", () => {
    expect(compactRecordText("success", undefined, { preTokens: 156_000, postTokens: 42_000 }))
      .toBe("🗜 已压缩上下文 156k → 42k tokens（-73%）");
  });

  it("成功无元数据：退化文案", () => {
    expect(compactRecordText("success", undefined, null)).toBe("🗜 已压缩上下文");
    expect(compactRecordText("success", undefined, { preTokens: 156_000 })).toBe("🗜 已压缩上下文");
  });

  it("失败：带原因并说明继续使用当前上下文", () => {
    expect(compactRecordText("failed", "boom", null)).toBe("⚠️ 上下文压缩失败：boom，继续使用当前上下文");
    expect(compactRecordText("failed", undefined, null)).toBe("⚠️ 上下文压缩失败，继续使用当前上下文");
  });

  it("小 token 数不走 k 缩写；pre 为 0 不出百分比", () => {
    expect(compactRecordText("success", undefined, { preTokens: 500, postTokens: 400 }))
      .toBe("🗜 已压缩上下文 500 → 400 tokens（-20%）");
    expect(compactRecordText("success", undefined, { preTokens: 0, postTokens: 0 }))
      .toBe("🗜 已压缩上下文 0 → 0 tokens");
  });
});
