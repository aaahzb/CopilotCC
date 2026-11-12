import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { packagePty, readSuccessfulPtyRoute } from "../scripts/package-pty.mjs";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { verifyNativeLayout } from "../scripts/verify-native-layout.mjs";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { runMacPackaging } from "../scripts/sign-mac-app.mjs";

const tempDirs: string[] = [];

/** 创建由本测试独占的临时目录。 @returns 绝对路径。 */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-native-layout-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  }
});

describe("原生 PTY 发行布局", () => {
  it("直接路线包含目标 node-pty JS 和全部本机文件，哈希可复核", async () => {
    const outDir = path.join(tempDir(), "dist");
    fs.mkdirSync(outDir);
    await packagePty({ target: "win", backend: "bun-node-pty", outDir, nodeRuntime: null });
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "pty-manifest.json"), "utf8"));
    expect(manifest.backend).toBe("bun-node-pty");
    expect(manifest.nodeMajor).toBeNull();
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith("node-pty/package.json"))).toBe(true);
    expect(manifest.files.some((f: { path: string }) => f.path === "pty/node_modules/node-addon-api/package.json")).toBe(true);
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith(".node"))).toBe(true);
    expect(manifest.files.every((f: { sha256: string }) => /^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith("conpty/conpty.dll"))).toBe(true);
    expect(manifest.files.some((f: { path: string }) => f.path.endsWith("conpty/OpenConsole.exe"))).toBe(true);
    const utilsPath = path.join(outDir, "pty", "node_modules", "node-pty", "lib", "utils.js");
    const utilsSource = fs.readFileSync(utilsPath, "utf8");
    expect(utilsSource).toContain("CCC_WINDOWS_LONG_PATH_NATIVE_FALLBACK");
    expect(utilsSource).toContain("process.dlopen");
    expect(manifest.files.some((f: { path: string }) => f.path.includes("darwin-arm64"))).toBe(false);
    await expect(verifyNativeLayout(outDir, "win32", "x64")).resolves.toBe(true);
  });

  it("helper 路线携带 Node 22、helper.cjs 与原生包，缺文件会失败", async () => {
    const root = tempDir();
    const outDir = path.join(root, "dist");
    const fakeNode = path.join(root, "node.exe");
    fs.mkdirSync(outDir);
    fs.writeFileSync(fakeNode, "fake node fixture", "utf8");
    await packagePty({
      target: "win", backend: "node-helper", outDir, nodeRuntime: fakeNode,
      readNodeMajor: () => 22,
      buildHelper: (helperPath: string) => fs.writeFileSync(helperPath, "// helper fixture\n", "utf8"),
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "pty-manifest.json"), "utf8"));
    expect(manifest.nodeMajor).toBe(22);
    expect(fs.existsSync(path.join(outDir, "pty", "helper.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "runtime", "node.exe"))).toBe(true);
    await expect(verifyNativeLayout(outDir, "win32", "x64")).resolves.toBe(true);
    fs.rmSync(path.join(outDir, "pty", "node_modules", "node-pty", "prebuilds", "win32-x64", "conpty.node"));
    await expect(verifyNativeLayout(outDir, "win32", "x64")).rejects.toThrow("NATIVE_LAYOUT");
  });

  it("macOS 打包显式恢复发行副本的 spawn-helper 执行位", async () => {
    const outDir = path.join(tempDir(), "dist");
    fs.mkdirSync(outDir);
    const calls: Array<{ file: string; mode: number }> = [];

    await packagePty({
      target: "darwin", backend: "bun-node-pty", outDir, nodeRuntime: null,
      chmod: (file: string, mode: number) => { calls.push({ file, mode }); },
    });

    expect(calls).toEqual([{
      file: path.join(
        outDir, "pty", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper",
      ),
      mode: 0o755,
    }]);
  });

  it("macOS 主机发行校验拒绝无执行位的 spawn-helper", async () => {
    const outDir = path.join(tempDir(), "dist");
    fs.mkdirSync(outDir);
    await packagePty({ target: "darwin", backend: "bun-node-pty", outDir, nodeRuntime: null });
    let mode = 0o644;
    const host = { platform: "darwin", stat: () => ({ mode }) };

    await expect(verifyNativeLayout(outDir, "darwin", "arm64", host))
      .rejects.toThrow("spawn-helper is not executable");
    mode = 0o755;
    await expect(verifyNativeLayout(outDir, "darwin", "arm64", host)).resolves.toBe(true);
  });

  it("已登记 native 文件哈希被篡改时拒绝发行", async () => {
    const outDir = path.join(tempDir(), "dist");
    fs.mkdirSync(outDir);
    await packagePty({ target: "win", backend: "bun-node-pty", outDir, nodeRuntime: null });
    const addon = path.join(outDir, "pty", "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node");
    fs.appendFileSync(addon, "tamper");
    await expect(verifyNativeLayout(outDir, "win32", "x64")).rejects.toThrow("NATIVE_LAYOUT");
  });

  it("构建只接受同平台且六项行为全部通过的探针路线", () => {
    const root = tempDir();
    const report = path.join(root, "pty-route.json");
    const behaviors = {
      initialSize: true, inputEcho: true, continuousTicks: true,
      chinese: true, resize: true, exitCode7: true,
    };
    fs.writeFileSync(report, JSON.stringify({
      schemaVersion: 1, platform: "win32", arch: "x64", selectedRoute: "bun-node-pty",
      routes: { "bun-node-pty": { pass: true, stage: "complete", behaviors } },
    }), "utf8");
    expect(readSuccessfulPtyRoute(report, "win")).toBe("bun-node-pty");
  });

  it("探针路线失败或目标不符时构建前拒绝", () => {
    const root = tempDir();
    const report = path.join(root, "pty-route.json");
    fs.writeFileSync(report, JSON.stringify({
      schemaVersion: 1, platform: "darwin", arch: "arm64", selectedRoute: "node-helper",
      routes: { "node-helper": { pass: false, stage: "runtime" } },
    }), "utf8");
    expect(() => readSuccessfulPtyRoute(report, "win")).toThrow("PTY_ROUTE_REPORT");
  });

  it("macOS 先签 .node/spawn-helper/runtime/托盘，再签主程序与整包并深校验", async () => {
    const root = tempDir();
    const app = path.join(root, "CopilotCC Bridge.app");
    const macos = path.join(app, "Contents", "MacOS");
    for (const file of [
      "pty/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "pty/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "runtime/node", "traybin/tray_darwin_release", "ccc-bridge",
    ]) {
      const target = path.join(macos, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "mach-o fixture");
    }
    const calls: string[][] = [];
    const commands = await runMacPackaging({
      appPath: app, dryRun: true,
      codesign: (args: string[]) => { calls.push(args); },
    });
    const nativeSign = commands.findIndex((command: string) => command.includes(".node") && command.startsWith("codesign"));
    const appSign = commands.findIndex((command: string) => /CopilotCC Bridge\.app"?$/.test(command) && !command.includes("--verify"));
    expect(nativeSign).toBeGreaterThanOrEqual(0);
    expect(appSign).toBeGreaterThan(nativeSign);
    expect(commands.at(-1)).toContain("--verify --deep --strict");
    expect(calls).toHaveLength(0); // dryRun 只生成计划，不执行签名。
  });
});
