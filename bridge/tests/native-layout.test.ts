import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { packagePty, readSuccessfulPtyRoute } from "../scripts/package-pty.mjs";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { verifyNativeLayout } from "../scripts/verify-native-layout.mjs";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { runMacPackaging } from "../scripts/sign-mac-app.mjs";
// @ts-expect-error 构建脚本以 JSDoc 记录接口，Vitest 直接执行同一 ESM 文件。
import { stageMacPty } from "../scripts/stage-mac-pty.mjs";

const tempDirs: string[] = [];

/** 创建由本测试独占的临时目录。 @returns 绝对路径。 */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-native-layout-"));
  tempDirs.push(dir);
  return dir;
}

/** 写入测试文件并自动创建父目录。 @param file 目标路径。 @param content UTF-8 内容。 @returns 无。 */
function writeFixture(file: string, content = "fixture\n"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** 计算测试文件摘要。 @param file 文件路径。 @returns SHA-256 十六进制。 */
function fixtureHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * 创建符合代码/资源分离规则的 .app 与完整 PTY manifest。
 * @param root 测试临时目录。
 * @returns .app 绝对路径。
 */
function createMacAppFixture(root: string): string {
  const app = path.join(root, "CopilotCC Bridge.app");
  const macos = path.join(app, "Contents", "MacOS");
  const resources = path.join(app, "Contents", "Resources");
  const files: Array<{ path: string; sha256: string; size: number }> = [];
  const addManifestFile = (manifestPath: string, file: string): void => {
    writeFixture(file, `fixture:${manifestPath}\n`);
    files.push({ path: manifestPath, sha256: fixtureHash(file), size: fs.statSync(file).size });
  };
  for (const relative of [
    "pty/package.json",
    "pty/helper.cjs",
    "pty/node_modules/node-pty/package.json",
    "pty/node_modules/node-pty/lib/index.js",
    "pty/node_modules/node-pty/lib/utils.js",
    "pty/node_modules/node-pty/lib/unixTerminal.js",
    "pty/node_modules/node-addon-api/package.json",
  ]) addManifestFile(relative, path.join(resources, ...relative.split("/")));

  const moved = new Map([
    ["pty/node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "pty.node"],
    ["pty/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper", "spawn-helper"],
    ["runtime/node", "node"],
  ]);
  for (const [manifestPath, name] of moved) addManifestFile(manifestPath, path.join(macos, name));
  writeFixture(path.join(macos, "ccc-bridge"), "mach-o main fixture\n");
  writeFixture(path.join(macos, "traybin", "tray_darwin_release"), "mach-o tray fixture\n");
  for (const relative of ["ccc-bridge", "spawn-helper", "node", "traybin/tray_darwin_release"]) {
    fs.chmodSync(path.join(macos, ...relative.split("/")), 0o755);
  }
  writeFixture(path.join(resources, "icon.icns"), "icon fixture\n");
  writeFixture(path.join(resources, "pty-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    backend: "node-helper",
    target: "darwin",
    platform: "darwin",
    arch: "arm64",
    nodeMajor: 22,
    files,
  }, null, 2)}\n`);
  return app;
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

  it("Darwin .app 平面原生文件缺失时从 Contents/MacOS 加载并保持 helper 同目录", async () => {
    const outDir = path.join(tempDir(), "dist");
    fs.mkdirSync(outDir);
    await packagePty({ target: "darwin", backend: "bun-node-pty", outDir, nodeRuntime: null });
    const packageLib = path.join(outDir, "pty", "node_modules", "node-pty", "lib");
    const source = fs.readFileSync(path.join(packageLib, "utils.js"), "utf8");
    const appLib = path.join(
      outDir, "CopilotCC Bridge.app", "Contents", "Resources",
      "pty", "node_modules", "node-pty", "lib",
    );
    const nativeDir = path.join(outDir, "CopilotCC Bridge.app", "Contents", "MacOS");
    const nativePath = path.join(nativeDir, "pty.node");
    const nativeModule = { marker: "signed native fixture" };
    const exports: {
      loadNativeModule?: (name: string) => { dir: string; module: unknown };
    } = {};
    const context = {
      exports,
      module: { exports },
      __dirname: appLib,
      process: { platform: "darwin", arch: "arm64" },
      require: (request: string): unknown => {
        if (request === "path") return path;
        if (request === nativePath) return nativeModule;
        throw new Error(`flat native layout absent: ${request}`);
      },
    };
    vm.runInNewContext(source, context, { filename: "utils.js" });

    const loaded = exports.loadNativeModule?.("pty");
    expect(loaded?.module).toBe(nativeModule);
    expect(loaded?.dir).toBe(nativeDir);
    expect(path.resolve(appLib, `${loaded?.dir}/spawn-helper`)).toBe(path.join(nativeDir, "spawn-helper"));
  });

  it("macOS staging 从真实发行包生成代码/资源分离布局", async () => {
    const root = tempDir();
    const sourceDir = path.join(root, "dist");
    const fakeNode = path.join(root, "node");
    fs.mkdirSync(sourceDir);
    writeFixture(fakeNode, "node fixture\n");
    await packagePty({
      target: "darwin", backend: "node-helper", outDir: sourceDir, nodeRuntime: fakeNode,
      readNodeMajor: () => 22,
      buildHelper: (helperPath: string) => writeFixture(helperPath, "// helper fixture\n"),
    });
    const app = path.join(root, "CopilotCC Bridge.app");
    const macos = path.join(app, "Contents", "MacOS");
    const resources = path.join(app, "Contents", "Resources");
    for (const relative of ["ccc-bridge", "traybin/tray_darwin_release"]) {
      writeFixture(path.join(macos, relative), "mach-o fixture\n");
      fs.chmodSync(path.join(macos, relative), 0o755);
    }

    await stageMacPty({ sourceDir, appPath: app });

    expect(fs.existsSync(path.join(macos, "pty"))).toBe(false);
    expect(fs.existsSync(path.join(macos, "pty.node"))).toBe(true);
    expect(fs.existsSync(path.join(macos, "spawn-helper"))).toBe(true);
    expect(fs.existsSync(path.join(macos, "node"))).toBe(true);
    expect(fs.existsSync(path.join(resources, "pty", "node_modules", "node-addon-api", "node_addon_api.gyp"))).toBe(true);
    await expect(runMacPackaging({ appPath: app, dryRun: true })).resolves.toHaveLength(7);
  });

  it("macOS 拒绝把 node_modules 非代码文件留在 Contents/MacOS", async () => {
    const root = tempDir();
    const app = path.join(root, "CopilotCC Bridge.app");
    const macos = path.join(app, "Contents", "MacOS");
    for (const file of [
      "pty/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "pty/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      "pty/node_modules/node-addon-api/node_addon_api.gyp",
      "runtime/node", "traybin/tray_darwin_release", "ccc-bridge",
    ]) writeFixture(path.join(macos, file), "mach-o or data fixture\n");

    await expect(runMacPackaging({ appPath: app, dryRun: true }))
      .rejects.toThrow("non-code file in Contents/MacOS");
  });

  it("macOS 校验代码/资源分离布局，先签内层再签主程序与整包", async () => {
    const app = createMacAppFixture(tempDir());
    const calls: string[][] = [];
    const commands = await runMacPackaging({
      appPath: app, dryRun: true,
      codesign: (args: string[]) => { calls.push(args); },
    });
    const nativeSign = commands.findIndex((command: string) => command.includes("pty.node") && command.startsWith("codesign"));
    const appSign = commands.findIndex((command: string) => /CopilotCC Bridge\.app"?$/.test(command) && !command.includes("--verify"));
    expect(nativeSign).toBeGreaterThanOrEqual(0);
    expect(appSign).toBeGreaterThan(nativeSign);
    expect(commands.at(-1)).toContain("--verify --deep --strict");
    expect(calls).toHaveLength(0); // dryRun 只生成计划，不执行签名。
  });
});
