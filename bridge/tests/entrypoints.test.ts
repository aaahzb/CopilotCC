import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePortableRuntimeDirectory,
  terminalChildCommand,
  terminalHookCommand,
  terminalNativeDirectory,
} from "../src/runtime-entry";

/**
 * 读取真实生产入口，供依赖装配契约检查。
 * 服务单测会自行注入完整依赖，只有检查入口才能发现托盘漏接持久化。
 * @param entry 入口文件名
 * @returns UTF-8 源码
 */
function entrySource(entry: string): string {
  return fs.readFileSync(fileURLToPath(new URL(`../src/${entry}`, import.meta.url)), "utf-8");
}

describe("生产入口依赖装配", () => {
  it.each(["index.ts", "tray.ts"])("%s 注入同一配置目录的 workspace.json", (entry) => {
    const source = entrySource(entry);
    // 允许换行与注释夹在语句之间，但构造器、配置目录和文件名必须保持生产契约。
    const workspaceStore = /workspaceStore\s*:\s*new\s+WorkspaceStore\s*\(\s*path\.join\s*\(\s*configDir\s*\(\s*\)\s*,\s*["']workspace\.json["']\s*,?\s*\)\s*,?\s*\)/;
    expect(source).toMatch(workspaceStore);
  });

  it.each(["index.ts", "tray.ts"])("%s 仅在显式分支运行 command Hook helper", (entry) => {
    const source = entrySource(entry);
    expect(source).toContain('"--terminal-hook"');
    expect(source).toContain("runTerminalHookHelper");
  });

  it.each(["index.ts", "tray.ts"])("%s 仅在显式分支运行私有 terminal child", (entry) => {
    const source = entrySource(entry);
    expect(source).toContain('"--terminal-child"');
    expect(source).toContain("runTerminalChild");
  });

  it.each(["index.ts", "tray.ts"])("%s 注入系统终端启动与重启恢复适配器", (entry) => {
    const source = entrySource(entry);
    expect(source).toContain("SystemTerminalAdapter");
    expect(source).toContain("terminalChildCommand");
    expect(source).toMatch(/privateDir\s*:\s*path\.join\s*\(\s*configDir\s*\(\s*\)\s*,\s*["']terminal["']\s*\)/);
    expect(source).toMatch(/system\s*:\s*\(context\)\s*=>\s*systemTerminal\.start\(context\)/);
    expect(source).toMatch(/recover\s*:\s*\(record\)\s*=>\s*systemTerminal\.recover\(record\)/);
  });

  it.each(["index.ts", "tray.ts"])("%s 注入内嵌终端启动与身份确认后的恢复清理", (entry) => {
    const source = entrySource(entry);
    expect(source).toContain("createEmbeddedTerminalAdapter");
    expect(source).toMatch(/embedded\s*:\s*\(context\)\s*=>\s*embeddedTerminal\.start\(context\)/);
    expect(source).toMatch(/recoverEmbedded\s*:\s*\(record\)\s*=>\s*embeddedTerminal\.recover\(record\)/);
  });

  it.each(["index.ts", "tray.ts"])("%s 只有显式 PTY smoke 分支读取隔离假 CLI", (entry) => {
    const source = entrySource(entry);
    expect(source).toContain('"--pty-smoke"');
    expect(source).toContain("runPtySmoke");
    expect(source).toContain("CCC_PTY_SMOKE_CLI");
  });

  it.each(["index.ts", "tray.ts"])("%s 正常退出先等待 server.close 清理内嵌 PTY", (entry) => {
    const source = entrySource(entry);
    expect(source).toMatch(/releaseRuntimeOnExit\s*\(\s*configDir\s*\(\s*\)\s*,\s*\(\s*\)\s*=>\s*server\.close\s*\(\s*\)\s*\)/);
  });

  it("Windows 编译态从已校验便携目录选择 Console 包装", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-portable-entry-command-"));
    try {
      const hash = "a".repeat(64);
      const runtime = path.join(root, "runtime", hash);
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(path.join(runtime, "payload-manifest.json"), "{}\n", "utf8");
      expect(terminalChildCommand(
        "C:/outer/CopilotCC.exe", "C:/outer/CopilotCC.exe", "win32", runtime, root,
      )).toEqual({ executable: path.join(runtime, "ccc-terminal.exe"), prefixArgs: [] });
      expect(terminalNativeDirectory(
        "C:/outer/CopilotCC.exe", "C:/outer/CopilotCC.exe", runtime, root,
      )).toBe(runtime);
      expect(terminalNativeDirectory(
        "D:/repo/bridge/src/index.ts", "C:/node/node.exe", runtime, root,
      )).toBe(path.resolve("dist/native-dev"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("开发态使用项目 native-dev，编译态使用桥接 exe 旁目录", () => {
    expect(terminalNativeDirectory("D:/repo/bridge/src/index.ts", "C:/node/node.exe"))
      .toBe(path.resolve("dist/native-dev"));
    expect(terminalNativeDirectory("C:/dist/ccc-bridge.exe", "C:/dist/ccc-bridge.exe"))
      .toBe(path.resolve("C:/dist"));
  });

  it("开发态经入口旁 tsx，Windows 编译态使用独立 Console 包装", () => {
    const dev = terminalChildCommand("D:/repo/bridge/src/index.ts", "C:/node/node.exe");
    expect(dev.executable).toBe("C:/node/node.exe");
    expect(dev.prefixArgs[0]).toContain("tsx");
    expect(dev.prefixArgs[1]).toContain("index.ts");
    const windows = terminalChildCommand("C:/dist/ccc-bridge.exe", "C:/dist/ccc-bridge.exe", "win32");
    expect(windows).toEqual({
      executable: path.resolve("C:/dist/ccc-terminal.exe"),
      prefixArgs: [],
    });
    expect(windows.executable).not.toBe(path.resolve("C:/dist/ccc-bridge.exe"));
    expect(terminalChildCommand("/Applications/CopilotCC/ccc-bridge", "/Applications/CopilotCC/ccc-bridge", "darwin"))
      .toEqual({ executable: "/Applications/CopilotCC/ccc-bridge", prefixArgs: [] });
    expect(terminalHookCommand("33333333-3333-4333-8333-333333333333", {
      executable: "C:/bridge with space/ccc-terminal.exe", prefixArgs: [],
    })).toContain("--terminal-hook");
  });
});

describe("便携单文件负载目录", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 创建带清单的候选版本目录。 @returns 配置根与候选目录。 */
  function fixture(): { root: string; runtime: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-portable-entry-"));
    tempDirs.push(root);
    const runtime = path.join(root, "runtime", "b".repeat(64));
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "payload-manifest.json"), "{}\n", "utf8");
    return { root, runtime };
  }

  it("只接受配置 runtime 下带清单的哈希版本目录", () => {
    const { root, runtime } = fixture();
    expect(resolvePortableRuntimeDirectory(runtime, root)).toBe(runtime);
    expect(resolvePortableRuntimeDirectory(undefined, root)).toBeNull();
    expect(resolvePortableRuntimeDirectory("", root)).toBeNull();
  });

  it.each([
    ["相对路径", "relative"],
    ["错误父目录", "other"],
    ["非哈希目录", "runtime/not-a-hash"],
    ["缺失清单", "missing"],
  ])("拒绝%s", (_label, candidate) => {
    const { root, runtime } = fixture();
    const value = candidate === "relative" ? candidate : path.join(root, candidate);
    if (candidate === "runtime/not-a-hash") fs.mkdirSync(value, { recursive: true });
    if (candidate === "missing") fs.rmSync(path.join(runtime, "payload-manifest.json"));
    expect(() => resolvePortableRuntimeDirectory(
      candidate === "missing" ? runtime : value, root,
    )).toThrow("PORTABLE_RUNTIME_DIR");
  });

  it("拒绝用 junction 冒充版本目录", () => {
    const { root, runtime } = fixture();
    const target = path.join(root, "target");
    const link = path.join(root, "runtime", "c".repeat(64));
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "payload-manifest.json"), "{}\n", "utf8");
    fs.symlinkSync(target, link, "junction");
    expect(() => resolvePortableRuntimeDirectory(link, root)).toThrow("PORTABLE_RUNTIME_DIR");
    expect(resolvePortableRuntimeDirectory(runtime, root)).toBe(runtime);
  });
});
