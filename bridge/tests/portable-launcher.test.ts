import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/run-portable-launcher-tests.mjs", import.meta.url));

describe("Windows 绿色单文件启动器", () => {
  it.skipIf(process.platform !== "win32")("C# 清理、解压、复用、并发与路径边界全部通过", () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: path.dirname(path.dirname(script)),
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PORTABLE_LAUNCHER_TESTS_OK=");
  }, 180000);
});
