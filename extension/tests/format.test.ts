import { describe, it, expect } from "vitest";
import { shortModelName } from "../src/lib/format";

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
