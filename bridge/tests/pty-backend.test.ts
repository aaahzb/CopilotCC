import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BunPtyBackend } from "../src/bun-pty-backend";
import { NodePtyBackend } from "../src/node-pty-backend";
import { createPtyBackend, type PtySpawnOptions } from "../src/pty-backend";

const OPTIONS: PtySpawnOptions = {
  file: "claude",
  args: ["--resume", "11111111-1111-4111-8111-111111111111"],
  cwd: path.resolve("work"),
  cols: 100,
  rows: 30,
  env: { ONLY_TEST: "yes" },
};

class FakePty {
  readonly pid = 4321;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn();
  private dataCallback: ((data: string) => void) | undefined;
  private exitCallback: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(callback: (data: string) => void): { dispose: () => void } {
    this.dataCallback = callback;
    return { dispose: () => { this.dataCallback = undefined; } };
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitCallback = callback;
    return { dispose: () => { this.exitCallback = undefined; } };
  }

  emitData(data: string): void { this.dataCallback?.(data); }
  emitExit(exitCode: number, signal?: number): void { this.exitCallback?.({ exitCode, signal }); }
}

class FakeHelper extends EventEmitter {
  readonly stdin = { write: vi.fn(), on: vi.fn(), writable: true };
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();

  respond(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  requests(): Array<Record<string, unknown>> {
    return this.stdin.write.mock.calls.map(([data]) => JSON.parse(String(data)) as Record<string, unknown>);
  }
}

describe("BunPtyBackend", () => {
  it("统一数据、退出、输入、resize 和环境事件", async () => {
    const fake = new FakePty();
    const spawn = vi.fn(() => fake);
    const backend = new BunPtyBackend({
      executableDir: "C:/native",
      require: (id) => {
        expect(id).toContain("node-pty");
        return { spawn } as never;
      },
    });
    const proc = await backend.spawn(OPTIONS);
    const data: string[] = [];
    const exits: Array<{ exitCode: number; signal: number | null }> = [];
    proc.onData((chunk) => data.push(chunk));
    proc.onExit((event) => exits.push(event));

    expect(proc.pid).toBe(4321);
    expect(spawn).toHaveBeenCalledWith(OPTIONS.file, OPTIONS.args, expect.objectContaining({
      cwd: OPTIONS.cwd, cols: 100, rows: 30, env: OPTIONS.env,
    }));
    proc.write("中文\r");
    proc.resize(132, 36);
    expect(fake.write).toHaveBeenCalledWith("中文\r");
    expect(fake.resize).toHaveBeenCalledWith(132, 36);
    fake.emitData("tool output");
    fake.emitExit(0);
    await vi.waitFor(() => expect(exits).toEqual([{ exitCode: 0, signal: null }]));
    expect(data).toEqual(["tool output"]);
    await backend.close();
  });

  it("kill 幂等，迟到 data 被丢弃而 exit 仍分发一次", async () => {
    const fake = new FakePty();
    const backend = new BunPtyBackend({ executableDir: "C:/native", require: () => ({ spawn: () => fake }) as never });
    const proc = await backend.spawn(OPTIONS);
    const data: string[] = [];
    const exits: number[] = [];
    proc.onData((chunk) => data.push(chunk));
    proc.onExit(({ exitCode }) => exits.push(exitCode));
    await Promise.all([proc.kill(), proc.kill()]);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    fake.emitData("旧进程");
    fake.emitExit(7);
    fake.emitExit(7);
    await vi.waitFor(() => expect(exits).toEqual([7]));
    expect(data).toEqual([]);
  });

  it("Windows 长路径 ConPTY 加载失败时使用扩展路径并只重试一次", async () => {
    const fake = new FakePty();
    const nativeExports = { startProcess: vi.fn() };
    const originalLoader = vi.fn((_name: string): { dir: string; module: unknown } => {
      throw new Error("原加载器不应在扩展路径回退期间处理 conpty");
    });
    const utils = { loadNativeModule: originalLoader };
    const spawn = vi.fn(() => {
      if (spawn.mock.calls.length === 1) {
        throw new Error("Failed to load native module: conpty.node: LoadLibrary failed: path too long");
      }
      // 第二次进入 node-pty 时应由本次扩展路径加载结果提供原生实现。
      expect(utils.loadNativeModule("conpty")).toEqual({ dir: "extended", module: nativeExports });
      return fake;
    });
    const dlopen = vi.fn((module: { exports: unknown }, file: string) => {
      expect(file.startsWith("\\\\?\\")).toBe(true);
      module.exports = nativeExports;
    });
    const backend = new BunPtyBackend({
      executableDir: path.win32.join("C:\\", "native", "x".repeat(230)),
      platform: "win32",
      arch: "x64",
      dlopen,
      require: (id) => (/utils\.js$/.test(id) ? utils : { spawn }) as never,
    });

    const proc = await backend.spawn(OPTIONS);

    expect(proc.pid).toBe(4321);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(dlopen).toHaveBeenCalledTimes(1);
    expect(utils.loadNativeModule).toBe(originalLoader);
    await backend.close();
  });

  it("非原生加载错误不重启 PTY，也不调用 dlopen", async () => {
    const failure = new Error("spawn CLI failed after native load");
    const spawn = vi.fn(() => { throw failure; });
    const dlopen = vi.fn();
    const backend = new BunPtyBackend({
      executableDir: path.win32.join("C:\\", "native", "x".repeat(230)),
      platform: "win32",
      arch: "x64",
      dlopen,
      require: () => ({ spawn }) as never,
    });

    await expect(backend.spawn(OPTIONS)).rejects.toBe(failure);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(dlopen).not.toHaveBeenCalled();
  });
});

describe("NodePtyBackend", () => {
  it("按 JSONL 帧分发多行输出，helper 失败只关闭该后端", async () => {
    const helper = new FakeHelper();
    const backend = new NodePtyBackend({
      nodePath: "C:/runtime/node.exe",
      helperPath: "C:/pty/helper.cjs",
      spawn: vi.fn(() => helper) as never,
    });
    const pending = backend.spawn(OPTIONS);
    helper.respond({ type: "started", id: 1, pid: 99 });
    const proc = await pending;
    const data: string[] = [];
    const exits: number[] = [];
    proc.onData((chunk) => data.push(chunk));
    proc.onExit(({ exitCode }) => exits.push(exitCode));
    helper.respond({ type: "data", id: 1, data: "第一行\r\n第二行" });
    await vi.waitFor(() => expect(data.join("")).toBe("第一行\r\n第二行"));
    expect(proc.pid).toBe(99);

    helper.emit("error", new Error("helper exited"));
    await vi.waitFor(() => expect(backend.closed()).toBe(true));
    expect(exits).toEqual([1]);
    await backend.close();
  });

  it("kill 只发送一次，旧 data 不进入已关闭进程", async () => {
    const helper = new FakeHelper();
    const backend = new NodePtyBackend({ nodePath: "node", helperPath: "helper.cjs", spawn: () => helper as never });
    const pending = backend.spawn(OPTIONS);
    helper.respond({ type: "started", id: 1, pid: 99 });
    const proc = await pending;
    const data: string[] = [];
    proc.onData((chunk) => data.push(chunk));
    await Promise.all([proc.kill(), proc.kill()]);
    expect(helper.requests().filter((frame) => frame.type === "kill")).toHaveLength(1);
    helper.respond({ type: "data", id: 1, data: "旧进程" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(data).toEqual([]);
    await backend.close();
  });

  it("started 同批到达的初始输出会在订阅后补发", async () => {
    const helper = new FakeHelper();
    const backend = new NodePtyBackend({ nodePath: "node", helperPath: "helper.cjs", spawn: () => helper as never });
    const pending = backend.spawn(OPTIONS);
    helper.stdout.write(`${JSON.stringify({ type: "started", id: 1, pid: 99 })}\n${JSON.stringify({ type: "data", id: 1, data: "SIZE:80x24" })}\n`);
    const proc = await pending;
    const data: string[] = [];
    proc.onData((chunk) => data.push(chunk));
    await vi.waitFor(() => expect(data).toEqual(["SIZE:80x24"]));
    await backend.close();
  });

  it("started 前的 helper 错误会拒绝 spawn，不影响其他后端实例", async () => {
    const helper = new FakeHelper();
    const backend = new NodePtyBackend({ nodePath: "node", helperPath: "helper.cjs", spawn: () => helper as never });
    const pending = backend.spawn(OPTIONS);
    helper.respond({ type: "error", id: 1, code: "SPAWN_FAILED", message: "missing executable" });
    await expect(pending).rejects.toThrow("SPAWN_FAILED");
    expect(backend.closed()).toBe(false);
    await backend.close();
  });
});

describe("createPtyBackend", () => {
  it("只创建选定路线，工厂本身不启动原生进程", () => {
    expect(createPtyBackend("bun-node-pty", "C:/native").kind).toBe("bun-node-pty");
    expect(createPtyBackend("node-helper", "C:/native").kind).toBe("node-helper");
  });

  it("macOS .app 的 helper 使用代码区 Node 和 Resources 中的脚本", () => {
    const resources = path.resolve("/Applications/CopilotCC Bridge.app/Contents/Resources");
    const backend = createPtyBackend("node-helper", resources) as unknown as {
      options: { nodePath: string; helperPath: string };
    };

    expect(backend.options.nodePath).toBe(path.resolve(resources, "..", "MacOS", "node"));
    expect(backend.options.helperPath).toBe(path.join(resources, "pty", "helper.cjs"));
  });
});
