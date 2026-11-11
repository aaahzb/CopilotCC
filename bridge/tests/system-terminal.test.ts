import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemTerminalAdapter, shellQuote } from "../src/system-terminal";
import type { TerminalStartContext } from "../src/terminal-lease";
import { ensureShellEnvFallback, resolveClaudeExecutable } from "../src/claude-session";

const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";
const HOOK_TOKEN = "private-hook-token";
const tempDirs: string[] = [];
let privateDir: string;

function context(over: Partial<TerminalStartContext> = {}): TerminalStartContext {
  return {
    leaseId: LEASE_ID, hookToken: HOOK_TOKEN, mode: "system", folder: "D:/notes",
    initialSessionId: SID_1, resumeSessionId: SID_1, cliPath: "C:/claude.exe", port: 19280,
    privateDir, ...over,
  };
}

function fakeLaunch(): { spawnImpl: ReturnType<typeof vi.fn>; childCommand: { executable: string; prefixArgs: string[] } } {
  const childCommand = { executable: "C:/bridge/ccc-bridge.exe", prefixArgs: [] as string[] };
  const spawnImpl = vi.fn(() => {
    fs.writeFileSync(path.join(privateDir, `${LEASE_ID}.status.json`), JSON.stringify({
      leaseId: LEASE_ID, pid: 4321, executable: childCommand.executable,
      startedAt: "2026-11-10T08:00:00.000Z",
    }), "utf8");
    return new EventEmitter() as ChildProcess;
  });
  return { spawnImpl, childCommand };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SystemTerminalAdapter", () => {
  it("已有会话续聊且请求和命令行不暴露 token", async () => {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-terminal-"));
    tempDirs.push(privateDir);
    const { spawnImpl, childCommand } = fakeLaunch();
    const adapter = new SystemTerminalAdapter({
      platform: "win32", spawn: spawnImpl as never, which: () => "C:/WindowsTerminal/wt.exe",
      childCommand, probeVersion: async () => "2.1.316",
    });
    await adapter.start(context());
    expect(fs.existsSync(path.join(privateDir, `${LEASE_ID}.start`))).toBe(true);
    const requestRaw = fs.readFileSync(path.join(privateDir, `${LEASE_ID}.request.json`), "utf8");
    const request = JSON.parse(requestRaw);
    expect(request.args).toEqual(["--resume", SID_1, "--settings", expect.stringContaining(".settings.json")]);
    expect(requestRaw).not.toContain(HOOK_TOKEN);
    expect(JSON.stringify(spawnImpl.mock.calls)).not.toContain(HOOK_TOKEN);
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("C:/WindowsTerminal/wt.exe");
    expect(spawnImpl.mock.calls[0]?.[2]).toMatchObject({ windowsHide: false, detached: true });
  });

  it("无会话使用桥接 UUID，wt 缺失回退可见控制台并跟踪 exit.json", async () => {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-console-"));
    tempDirs.push(privateDir);
    const { spawnImpl, childCommand } = fakeLaunch();
    const adapter = new SystemTerminalAdapter({
      platform: "win32", spawn: spawnImpl as never, which: () => null,
      childCommand, probeVersion: async () => "unknown",
    });
    const handle = await adapter.start(context({ initialSessionId: null, resumeSessionId: SID_2 }));
    expect(handle.backend).toBe("windows-console");
    const request = JSON.parse(fs.readFileSync(path.join(privateDir, `${LEASE_ID}.request.json`), "utf8"));
    expect(request.args).toEqual(["--session-id", SID_2, "--settings", expect.any(String)]);
    expect(spawnImpl.mock.calls[0]?.[2]).toMatchObject({ windowsHide: false });
    const exited = vi.fn();
    handle.onExit(exited);
    fs.writeFileSync(path.join(privateDir, `${LEASE_ID}.exit.json`), JSON.stringify({
      leaseId: LEASE_ID, exitCode: 0, reason: "exit",
    }), "utf8");
    await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(0, "exit"));
  });

  it("窗口关闭使包装进程消失且未写 exit.json 时也通知真实退出", async () => {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-terminal-process-exit-"));
    tempDirs.push(privateDir);
    const { spawnImpl, childCommand } = fakeLaunch();
    const adapter = new SystemTerminalAdapter({
      platform: "win32", spawn: spawnImpl as never, which: () => "C:/WindowsTerminal/wt.exe",
      childCommand, probeVersion: async () => "2.1.316", isProcessAlive: () => false,
    });
    const handle = await adapter.start(context());
    const exited = vi.fn();
    handle.onExit(exited);
    await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(null, "process-exit"));
  });

  it("包装进程状态未知或仍存活时不伪造退出", async () => {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-terminal-process-unknown-"));
    tempDirs.push(privateDir);
    const { spawnImpl, childCommand } = fakeLaunch();
    const adapter = new SystemTerminalAdapter({
      platform: "win32", spawn: spawnImpl as never, which: () => "C:/WindowsTerminal/wt.exe",
      childCommand, probeVersion: async () => "2.1.316", isProcessAlive: () => true,
    });
    const handle = await adapter.start(context());
    const exited = vi.fn();
    handle.onExit(exited);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(exited).not.toHaveBeenCalled();
  });

  it("status 超过 5 秒才到达时仍完成启动并发送启动准许", async () => {
    vi.useFakeTimers();
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-terminal-slow-"));
    tempDirs.push(privateDir);
    const childCommand = { executable: "C:/bridge/ccc-bridge.exe", prefixArgs: [] as string[] };
    const spawnImpl = vi.fn(() => {
      setTimeout(() => {
        fs.writeFileSync(path.join(privateDir, `${LEASE_ID}.status.json`), JSON.stringify({
          leaseId: LEASE_ID, pid: 4321, executable: childCommand.executable,
          startedAt: "2026-11-10T08:00:00.000Z",
        }), "utf8");
      }, 6100);
      return new EventEmitter() as ChildProcess;
    });
    const adapter = new SystemTerminalAdapter({
      platform: "win32", spawn: spawnImpl as never, which: () => "C:/WindowsTerminal/wt.exe",
      childCommand, probeVersion: async () => "2.1.316",
    });
    const outcome = adapter.start(context()).then(
      (handle) => ({ handle, error: null }),
      (error: unknown) => ({ handle: null, error }),
    );
    await vi.advanceTimersByTimeAsync(6200);
    const result = await outcome;
    expect(result.error).toBeNull();
    expect(result.handle?.pid).toBe(4321);
    expect(fs.existsSync(path.join(privateDir, `${LEASE_ID}.start`))).toBe(true);
    expect(fs.existsSync(path.join(privateDir, `${LEASE_ID}.cancel`))).toBe(false);
  });

  it("最终状态超时仍明确失败并写 cancel，不留下可启动的迟到 CLI", async () => {
    vi.useFakeTimers();
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-terminal-timeout-"));
    tempDirs.push(privateDir);
    const { spawnImpl, childCommand } = fakeLaunch();
    spawnImpl.mockImplementation(() => new EventEmitter() as ChildProcess);
    const adapter = new SystemTerminalAdapter({
      platform: "win32", spawn: spawnImpl as never, which: () => "C:/WindowsTerminal/wt.exe",
      childCommand, probeVersion: async () => "2.1.316",
    });
    const outcome = adapter.start(context()).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(20_100);
    await expect(outcome).resolves.toEqual(new Error("TERMINAL_STATUS_TIMEOUT"));
    expect(fs.existsSync(path.join(privateDir, `${LEASE_ID}.start`))).toBe(false);
    expect(fs.existsSync(path.join(privateDir, `${LEASE_ID}.cancel`))).toBe(true);
  });

  it("macOS 用 Terminal.app，shellQuote 保护空格和单引号", async () => {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-system-mac-"));
    tempDirs.push(privateDir);
    const { spawnImpl, childCommand } = fakeLaunch();
    const adapter = new SystemTerminalAdapter({
      platform: "darwin", spawn: spawnImpl as never, which: () => null,
      childCommand, probeVersion: async () => "unknown",
    });
    await adapter.start(context({ folder: "/tmp/中文 and 'quote'", cliPath: "/usr/local/bin/claude" }));
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("osascript");
    expect(spawnImpl.mock.calls[0]?.[1]?.join(" ")).toContain('tell application "Terminal"');
    expect(spawnImpl.mock.calls[0]?.[1]?.join(" ")).toContain("'\"'\"'");
    expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
  });

  it("CLI 路径和 shell 环境解析复用现有生产函数", () => {
    expect(resolveClaudeExecutable).toBeTypeOf("function");
    expect(ensureShellEnvFallback).toBeTypeOf("function");
  });
});
