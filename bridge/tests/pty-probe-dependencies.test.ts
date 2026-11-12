import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { stagePtyDependencies } from "../scripts/pty-probe-dependencies.mjs";

const tempDirs: string[] = [];

/** 创建只含两个最小依赖包的探针夹具。 @returns 源目录与暂存目录。 */
function fixture(): { bridgeRoot: string; modules: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-pty-probe-deps-"));
  tempDirs.push(root);
  const bridgeRoot = path.join(root, "bridge");
  for (const name of ["node-pty", "node-addon-api"]) {
    const packageDir = path.join(bridgeRoot, "node_modules", name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name })}\n`, "utf8");
    fs.writeFileSync(path.join(packageDir, "LICENSE"), `${name} first route\n`, "utf8");
  }
  return { bridgeRoot, modules: path.join(root, "probe", "pty", "node_modules") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

describe("PTY 探针依赖暂存", () => {
  it("auto 回退复用完整暂存，不重复复制或覆盖前一路线", () => {
    const f = fixture();
    stagePtyDependencies(f.bridgeRoot, f.modules);
    expect(fs.readFileSync(path.join(f.modules, "node-pty", "LICENSE"), "utf8"))
      .toBe("node-pty first route\n");

    // 第二路线进入时源包即使变化，也不得重新复制并覆盖已完成的暂存。
    fs.writeFileSync(
      path.join(f.bridgeRoot, "node_modules", "node-pty", "LICENSE"),
      "unexpected recopy\n",
      "utf8",
    );
    expect(() => stagePtyDependencies(f.bridgeRoot, f.modules)).not.toThrow();
    expect(fs.readFileSync(path.join(f.modules, "node-pty", "LICENSE"), "utf8"))
      .toBe("node-pty first route\n");
  });

  it("Darwin 暂存恢复目标 spawn-helper 执行位后才写完成标记", () => {
    const f = fixture();
    const sourceHelper = path.join(
      f.bridgeRoot, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper",
    );
    fs.mkdirSync(path.dirname(sourceHelper), { recursive: true });
    fs.writeFileSync(sourceHelper, "mach-o fixture\n", "utf8");
    const calls: Array<{ file: string; mode: number }> = [];

    stagePtyDependencies(f.bridgeRoot, f.modules, {
      platform: "darwin",
      arch: "arm64",
      chmod: (file: string, mode: number) => { calls.push({ file, mode }); },
    });

    expect(calls).toEqual([{
      file: path.join(f.modules, "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
      mode: 0o755,
    }]);
  });

  it("没有完成标记的半成品仍明确拒绝，不能静默复用", () => {
    const f = fixture();
    const partial = path.join(f.modules, "node-pty");
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, "LICENSE"), "partial copy\n", "utf8");

    expect(() => stagePtyDependencies(f.bridgeRoot, f.modules))
      .toThrow("PTY_PROBE_DEPENDENCIES_INCOMPLETE");
  });
});
