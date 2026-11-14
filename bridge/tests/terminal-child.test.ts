import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTerminalChild, terminalChildErrorCode, type TerminalChildRequest } from "../src/terminal-child";

const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function requestFixture(): { requestFile: string; request: TerminalChildRequest; cliPath: string } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-terminal-child-"));
  tempDirs.push(work);
  const cliPath = path.resolve(work, "claude.exe");
  const request: TerminalChildRequest = {
    leaseId: LEASE_ID,
    cwd: work,
    cliPath,
    args: ["--resume", "11111111-1111-4111-8111-111111111111"],
    exitFile: path.join(work, `${LEASE_ID}.exit.json`),
    stopFile: path.join(work, `${LEASE_ID}.stop`),
  };
  const requestFile = path.join(work, `${LEASE_ID}.request.json`);
  fs.writeFileSync(requestFile, JSON.stringify(request), "utf8");
  return { requestFile, request, cliPath };
}

describe("runTerminalChild", () => {
  it("status 后等待桥接 start 准许才启动 CLI，退出写 exit.json", async () => {
    const { requestFile, request, cliPath } = requestFixture();
    const child = new EventEmitter() as ChildProcess;
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const identity = vi.fn(async () => ({
      pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z",
    }));
    const running = runTerminalChild(requestFile, { spawn: spawnImpl as never, identity });
    const statusFile = path.join(request.cwd, `${LEASE_ID}.status.json`);
    await vi.waitFor(() => expect(fs.existsSync(statusFile)).toBe(true));
    expect(spawnImpl.mock.calls.length).toBe(0);
    fs.writeFileSync(path.join(request.cwd, `${LEASE_ID}.start`), "", "utf8");
    await running;
    const requestRaw = fs.readFileSync(requestFile, "utf8");
    expect(requestRaw).not.toContain("ANTHROPIC");
    expect(identity).toHaveBeenCalledOnce();
    expect(spawnImpl).toHaveBeenCalledWith(cliPath, request.args, expect.objectContaining({
      cwd: request.cwd, stdio: "inherit", env: process.env, windowsHide: false,
    }));
    const status = JSON.parse(fs.readFileSync(path.join(request.cwd, `${LEASE_ID}.status.json`), "utf8"));
    expect(status).toMatchObject({ leaseId: LEASE_ID, pid: 1234 });
    expect(JSON.parse(fs.readFileSync(request.exitFile, "utf8"))).toEqual({
      leaseId: LEASE_ID, exitCode: 0, reason: "exit",
    });
  });

  it("桥接最终失败写 cancel 后，包装进程不得启动 CLI", async () => {
    const { requestFile, request } = requestFixture();
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const running = runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" }),
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(request.cwd, `${LEASE_ID}.status.json`))).toBe(true));
    fs.writeFileSync(path.join(request.cwd, `${LEASE_ID}.cancel`), "", "utf8");
    await running;
    expect(spawnImpl.mock.calls.length).toBe(0);
    expect(fs.existsSync(request.exitFile)).toBe(false);
  });

  it("start 与 stop 竞态时在 spawn 前再次检查停止文件", async () => {
    const { requestFile, request } = requestFixture();
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const running = runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" }),
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(request.cwd, `${LEASE_ID}.status.json`))).toBe(true));
    fs.writeFileSync(request.stopFile, "", "utf8");
    fs.writeFileSync(path.join(request.cwd, `${LEASE_ID}.start`), "", "utf8");
    await running;
    expect(spawnImpl.mock.calls.length).toBe(0);
  });

  it("桥接消失且启动准许有界超时，不启动失控 CLI", async () => {
    vi.useFakeTimers();
    const { requestFile, request } = requestFixture();
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const running = runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" }),
    });
    const outcome = running.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_100);
    await expect(outcome).resolves.toEqual(new Error("TERMINAL_CHILD_START_TIMEOUT"));
    expect(spawnImpl.mock.calls.length).toBe(0);
    expect(fs.existsSync(request.exitFile)).toBe(false);
  });

  it("非法 lease 或越界退出文件在启动 CLI 前拒绝", async () => {
    const { requestFile, request } = requestFixture();
    const spawnImpl = vi.fn();
    fs.writeFileSync(requestFile, JSON.stringify({ ...request, leaseId: "../escape" }), "utf8");
    await expect(runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1, executable: "x", startedAt: "2026-11-10T08:00:00.000Z" }),
    })).rejects.toThrow("TERMINAL_CHILD_REQUEST");
    expect(spawnImpl.mock.calls.length).toBe(0);
  });

  it("脱敏诊断保留固定与系统错误码，但不暴露原始异常正文", () => {
    expect(terminalChildErrorCode(new Error("TERMINAL_CHILD_IDENTITY"))).toBe("TERMINAL_CHILD_IDENTITY");
    const io = Object.assign(new Error("ENOENT: /private/request/token-content"), { code: "ENOENT" });
    expect(terminalChildErrorCode(io)).toBe("ENOENT");
    expect(terminalChildErrorCode(new Error("token=secret /private/request.json"))).toBe("TERMINAL_CHILD_UNKNOWN");
  });

  it.each(["src/index.ts", "src/tray.ts"])("%s 保留固定错误码且不泄露私有请求路径", (entry) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-terminal-entry-"));
    tempDirs.push(work);
    const directory = path.join(work, "terminal");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const requestFile = path.join(directory, `${LEASE_ID}.request.json`);
    fs.writeFileSync(requestFile, "{invalid-private-json", { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(process.execPath, [
      path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
      path.resolve(entry), "--terminal-child", requestFile,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, CCC_BRIDGE_HOME: work },
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TERMINAL_CHILD_REQUEST");
    expect(result.stderr).not.toContain(requestFile);
    expect(result.stderr).not.toContain("invalid-private-json");
  });
});
