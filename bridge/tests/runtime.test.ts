import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claimInstance, writeRuntime, releaseRuntime, releaseRuntimeOnExit, isPidAlive } from "../src/runtime";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-runtime-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("单实例守卫", () => {
  it("claim 写入 runtime.json；writeRuntime 补端口；release 仅删自己的记录", () => {
    claimInstance(dir);
    const info = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf-8"));
    expect(info.pid).toBe(process.pid);
    writeRuntime(dir, 19280);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf-8")).port).toBe(19280);
    // 别的进程(pid 不同)的记录不被 release 误删
    fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ pid: process.pid + 999999, port: 1 }));
    releaseRuntime(dir);
    expect(fs.existsSync(path.join(dir, "runtime.json"))).toBe(true);
    // 自己的记录会被删
    claimInstance(dir);
    releaseRuntime(dir);
    expect(fs.existsSync(path.join(dir, "runtime.json"))).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("已有存活实例时 claim 抛错；实例死后 claim 正常接管", async () => {
    // 存活的其他进程：spawn 一个常驻子进程模拟另一个桥接实例
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    await new Promise<void>((r) => child.once("spawn", () => r()));
    try {
      fs.writeFileSync(path.join(dir, "runtime.json"), JSON.stringify({ pid: child.pid, port: 19280 }));
      expect(() => claimInstance(dir)).toThrow(/已有 ccc-bridge 实例/);
      // 子进程退出后（pid 死掉），claim 正常接管
      child.kill();
      await new Promise<void>((r) => child.once("exit", () => r()));
      expect(() => claimInstance(dir)).not.toThrow();
    } finally {
      child.kill();
    }
  });
});

describe("正常退出清理", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["SIGTERM", "SIGHUP"] as const)("%s 等待异步服务关闭后才释放 runtime 并退出，重复信号只关闭一次", async (signal) => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      handlers.set(event, listener);
      return process;
    }) as unknown as typeof process.on);
    const exitCodes: Array<number | null> = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number | null) => {
      exitCodes.push(code ?? null);
      return undefined as never;
    }) as typeof process.exit);
    let finishClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    writeRuntime(dir, 19280);

    releaseRuntimeOnExit(dir, close);
    handlers.get(signal)?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([]);
    expect(fs.existsSync(path.join(dir, "runtime.json"))).toBe(true);

    handlers.get("SIGINT")?.();
    finishClose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([0]);
    expect(fs.existsSync(path.join(dir, "runtime.json"))).toBe(false);
  });
});
