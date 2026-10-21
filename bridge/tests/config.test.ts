import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateConfig, DEFAULT_PORT, DEFAULT_EXTENSION_ORIGIN } from "../src/config";

/** 建临时目录，返回其路径 */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
}

describe("loadOrCreateConfig", () => {
  it("首次调用生成配置并落盘，token 为 64 位 hex", () => {
    const dir = tmpDir();
    const cfg = loadOrCreateConfig(dir);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("首次生成的白名单预置发布版扩展 Origin，新用户零配置", () => {
    const cfg = loadOrCreateConfig(tmpDir());
    expect(cfg.allowedOrigins).toEqual([DEFAULT_EXTENSION_ORIGIN]);
  });

  it("再次调用复用已有 token，不重新生成", () => {
    const dir = tmpDir();
    const a = loadOrCreateConfig(dir);
    const b = loadOrCreateConfig(dir);
    expect(b.token).toBe(a.token);
  });

  it("已存在的空数组白名单不被迁移（空数组是刻意的开发模式）", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ token: "t".repeat(64), port: 1234, allowedOrigins: [], createdAt: "" }),
      "utf-8",
    );
    expect(loadOrCreateConfig(dir).allowedOrigins).toEqual([]);
  });

  it("配置文件损坏时抛出错误", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "config.json"), "{bad json", "utf-8");
    expect(() => loadOrCreateConfig(dir)).toThrow();
  });
});

describe("DEFAULT_EXTENSION_ORIGIN", () => {
  it("与 extension/wxt.config.ts 的 manifest key 推导一致（换 key 必须同步）", () => {
    // 测试文件在 bridge/tests/，仓库根在上两级
    const wxtPath = fileURLToPath(new URL("../../extension/wxt.config.ts", import.meta.url));
    const src = fs.readFileSync(wxtPath, "utf-8");
    const m = src.match(/key:\s*"([A-Za-z0-9+/=]+)"/);
    expect(m, "wxt.config.ts 里应能找到 manifest key").toBeTruthy();
    // Chrome 扩展 ID 算法：公钥 DER 的 SHA-256 前 16 字节，每半字节映射 a-p
    const der = Buffer.from(m![1], "base64");
    const digest = createHash("sha256").update(der).digest();
    const id = [...digest.subarray(0, 16)]
      .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
      .join("");
    expect(`chrome-extension://${id}`).toBe(DEFAULT_EXTENSION_ORIGIN);
  });
});
