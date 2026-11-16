import { describe, expect, it } from "vitest";
import { supportsNoFlicker } from "../src/cli-capabilities";

describe("全屏启动失败计数规避开关的版本门槛", () => {
  // 该能力在 2.1.236 落地：更早版本没有这个变量，不能盲目注入。
  it.each([
    ["2.1.236", true],
    ["2.1.237", true],
    ["2.1.323", true],
    ["2.2.0", true],
    ["3.0.0", true],
    ["2.1.235", false],
    ["2.0.999", false],
    ["1.99.99", false],
    ["unknown", false],
    ["", false],
  ])("版本 %s 支持=%s", (version, expected) => {
    expect(supportsNoFlicker(version)).toBe(expected);
  });
});
