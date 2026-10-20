import { describe, it, expect } from "vitest";
import { encodePairing, decodePairing, PAIRING_PREFIX, PAIRING_FALLBACK_HOST, PAIRING_FALLBACK_PORT } from "../src/pairing";

describe("配对串", () => {
  it("编码→解码 roundtrip", () => {
    const info = { h: "127.0.0.1", p: 19280, t: "ab12cd34ef" };
    const s = encodePairing(info);
    expect(s.startsWith(PAIRING_PREFIX)).toBe(true);
    expect(decodePairing(s)).toEqual(info);
  });

  it("不同长度 roundtrip（覆盖 base64 余数分支）", () => {
    for (const t of ["a".repeat(8), "b".repeat(9), "c".repeat(10)]) {
      const info = { h: "127.0.0.1", p: 19281, t };
      expect(decodePairing(encodePairing(info))).toEqual(info);
    }
  });

  it("裸 token 回退默认地址与端口（兼容旧配对流程）", () => {
    expect(decodePairing("  deadbeef12345678 ")).toEqual({ h: PAIRING_FALLBACK_HOST, p: PAIRING_FALLBACK_PORT, t: "deadbeef12345678" });
  });

  it("垃圾输入返回 null", () => {
    expect(decodePairing("")).toBeNull();
    expect(decodePairing("ccc1.!!!")).toBeNull();
    expect(decodePairing("ccc1.aGVsbG8")).toBeNull(); // 合法 base64 但不是 JSON
    expect(decodePairing("这不是配对串")).toBeNull();
  });
});
