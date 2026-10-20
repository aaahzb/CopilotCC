import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadOrCreateConfig, DEFAULT_PORT } from "../src/config";

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

  it("再次调用复用已有 token，不重新生成", () => {
    const dir = tmpDir();
    const a = loadOrCreateConfig(dir);
    const b = loadOrCreateConfig(dir);
    expect(b.token).toBe(a.token);
  });

  it("配置文件损坏时抛出错误", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "config.json"), "{bad json", "utf-8");
    expect(() => loadOrCreateConfig(dir)).toThrow();
  });
});
