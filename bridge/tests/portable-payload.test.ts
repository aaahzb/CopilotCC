import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { buildPortableExe, createPayloadManifest } from "../scripts/build-portable-exe.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 创建最小完整负载。 @returns 临时源目录。 */
function payloadFixture(): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-portable-payload-"));
  tempDirs.push(source);
  fs.mkdirSync(path.join(source, "pty", "node_modules", "node-pty"), { recursive: true });
  fs.writeFileSync(path.join(source, "ccc-bridge.exe"), "bridge-v1\n");
  fs.writeFileSync(path.join(source, "ccc-terminal.exe"), "terminal-v1\n");
  fs.writeFileSync(path.join(source, "pty-manifest.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(source, "pty", "node_modules", "node-pty", "index.js"), "module.exports={};\n");
  return source;
}

describe("绿色单文件负载构建", () => {
  it("清单包含必要文件、真实大小和稳定内容哈希", () => {
    const source = payloadFixture();
    const first = createPayloadManifest(source);
    expect(first.manifest.product).toBe("CopilotCC");
    expect(first.manifest.schemaVersion).toBe(1);
    expect(first.manifest.mainExecutable).toBe("ccc-bridge.exe");
    expect(first.manifest.terminalExecutable).toBe("ccc-terminal.exe");
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.files.map((file: { path: string }) => file.path)).toEqual([
      "ccc-bridge.exe", "ccc-terminal.exe", "pty-manifest.json",
      "pty/node_modules/node-pty/index.js",
    ]);
    for (const file of first.manifest.files) {
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.size).toBe(fs.statSync(path.join(source, ...file.path.split("/"))).size);
    }
    expect(createPayloadManifest(source).payloadHash).toBe(first.payloadHash);
    fs.appendFileSync(path.join(source, "ccc-bridge.exe"), "changed\n");
    expect(createPayloadManifest(source).payloadHash).not.toBe(first.payloadHash);
  });

  it("缺必要组件或含 junction 时拒绝构建", () => {
    const missing = payloadFixture();
    fs.rmSync(path.join(missing, "ccc-terminal.exe"));
    expect(() => createPayloadManifest(missing)).toThrow("PORTABLE_PAYLOAD");

    const linked = payloadFixture();
    const target = path.join(linked, "pty-target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(linked, "pty-link"), "junction");
    expect(() => createPayloadManifest(linked)).toThrow("PORTABLE_PAYLOAD");
  });

  it.skipIf(process.platform !== "win32")("重复的大运行时只在压缩负载中保存一份数据块", async () => {
    const source = payloadFixture();
    const shared = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < shared.length; index += 1) shared[index] = (index * 31 + (index >>> 8)) & 255;
    fs.writeFileSync(path.join(source, "ccc-bridge.exe"), shared);
    fs.writeFileSync(path.join(source, "ccc-terminal.exe"), shared);
    const originalBytes = createPayloadManifest(source).manifest.files
      .reduce((total: number, file: { size: number }) => total + file.size, 0);
    const result = await buildPortableExe({ sourceDir: source, outDir: path.join(source, "public") });
    expect(result.storedBytes).toBeLessThanOrEqual(originalBytes - shared.length + 1024);
  }, 180000);

  it.skipIf(process.platform !== "win32")("真实构建公开目录只有压缩内嵌的单 exe", async () => {
    const source = payloadFixture();
    const outDir = path.join(source, "public");
    const result = await buildPortableExe({ sourceDir: source, outDir });
    expect(fs.readdirSync(outDir)).toEqual(["CopilotCC.exe"]);
    expect(result.bytes).toBe(fs.statSync(path.join(outDir, "CopilotCC.exe")).size);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.zipBytes).toBeGreaterThan(0);
    expect(result.zipBytes).toBeLessThan(20000);
  }, 180000);
});
