import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTerminalChild, terminalChildErrorCode, type TerminalChildRequest } from "../src/terminal-child";
import { enableStartupTiming } from "../src/startup-timing";

const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  enableStartupTiming(null);
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

  it("启用启动日志后记录身份查询、等待准许与 CLI 启动耗时", async () => {
    const { requestFile, request } = requestFixture();
    enableStartupTiming(request.cwd);
    const child = new EventEmitter() as ChildProcess;
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const running = runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" }),
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(request.cwd, `${LEASE_ID}.status.json`))).toBe(true));
    fs.writeFileSync(path.join(request.cwd, `${LEASE_ID}.start`), "", "utf8");
    await running;
    const logFile = path.join(request.cwd, "startup.log");
    await vi.waitFor(() => expect(fs.readFileSync(logFile, "utf8")).toMatch(
      /\[startup\] terminal-child identity=\d+ms status=\d+ms start=\d+ms spawn=\d+ms total=\d+ms/,
    ));
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

  /** 持续排空子进程输出，失败时返回尾部诊断文本，避免管道写满反过来卡住子进程。 */
  function collectOutput(child: ChildProcess): () => string {
    let text = "";
    const append = (data: string): void => { text = (text + data).slice(-16_384); };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return () => text.trim() || "（无输出）";
  }

  /** 等待 status 文件；包装进程提前退出时立即带退出码与输出失败，不把崩溃误报成超时。 */
  async function waitForStatus(file: string, child: ChildProcess, output: () => string): Promise<void> {
    // CI 并行跑全量测试时 tsx 冷启动可能明显变慢；正常路径 1~2s 内返回，放宽预算只影响失败耗时，
    // 进程一旦退出会立即带输出失败，不会把“启动即崩”拖成 25 秒。
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`包装进程在写 status 前退出（code=${child.exitCode}, signal=${child.signalCode}）\n${output()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`25s 内未生成 status 文件\n${output()}`);
  }

  /** 等待退出；exit 事件可能早于监听器注册，先检查 exitCode/signalCode。 */
  function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  }

  /** 等待启动日志异步落盘并出现完整包装耗时行。 */
  async function waitForLog(file: string, output: () => string): Promise<void> {
    const pattern = /\[startup\] terminal-child identity=\d+ms status=\d+ms start=\d+ms spawn=\d+ms total=\d+ms/;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(file) && pattern.test(fs.readFileSync(file, "utf8"))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`10s 内未写入完整启动日志：${file}\n${output()}`);
  }

  // --terminal-child 只由系统终端路径拉起，而 SystemTerminalAdapter 明确拒绝 Linux，
  // 所以成功路径只在 Windows/macOS 有意义；Linux 的入口接线由下面的非法请求用例覆盖。
  // 真实子进程要冷启动 tsx 并加载入口模块，用例级超时放宽到 45s；内部等待仍是实际完成条件。
  it.skipIf(process.platform === "linux").each(["src/index.ts", "src/tray.ts"])(
    "%s 成功路径启用启动日志并按段记录包装耗时",
    async (entry) => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-terminal-entry-log-"));
      tempDirs.push(work);
      const directory = path.join(work, "terminal");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const requestFile = path.join(directory, `${LEASE_ID}.request.json`);
      fs.writeFileSync(requestFile, JSON.stringify({
        leaseId: LEASE_ID,
        cwd: work,
        cliPath: process.execPath,
        args: ["-e", "0"], // 本地 Node 立即成功退出，不启动真实 Claude
        exitFile: path.join(directory, `${LEASE_ID}.exit.json`),
        stopFile: path.join(directory, `${LEASE_ID}.stop`),
      }), { encoding: "utf8", mode: 0o600 });
      const running = spawn(process.execPath, [
        path.resolve("node_modules", "tsx", "dist", "cli.mjs"),
        path.resolve(entry), "--terminal-child", requestFile,
      ], {
        cwd: path.resolve("."),
        env: { ...process.env, CCC_BRIDGE_HOME: work },
        stdio: ["ignore", "pipe", "pipe"], // 捕获入口输出，失败时能区分“慢”与“启动即崩”
        windowsHide: true,
      });
      const output = collectOutput(running);
      try {
        await waitForStatus(path.join(directory, `${LEASE_ID}.status.json`), running, output);
        fs.writeFileSync(path.join(directory, `${LEASE_ID}.start`), "", "utf8");
        const exit = await waitForExit(running);
        expect(exit, `入口异常退出，输出：\n${output()}`).toMatchObject({ code: 0 });
        await waitForLog(path.join(work, "startup.log"), output);
      } finally {
        // 失败时不要留下仍在等 .start 的包装进程。
        if (running.exitCode === null && running.signalCode === null) {
          running.kill();
          await Promise.race([
            waitForExit(running),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
      }
    },
    45_000,
  );

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

describe("runTerminalChild 全屏失败计数开关", () => {
  it("请求标记 noFlicker 时向 CLI 环境注入 CLAUDE_CODE_NO_FLICKER=1", async () => {
    const { requestFile, request, cliPath } = requestFixture();
    fs.writeFileSync(requestFile, JSON.stringify({ ...request, noFlicker: true }), "utf8");
    const child = new EventEmitter() as ChildProcess;
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const running = runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" }),
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(request.cwd, `${LEASE_ID}.status.json`))).toBe(true));
    fs.writeFileSync(path.join(request.cwd, `${LEASE_ID}.start`), "", "utf8");
    await running;
    expect(spawnImpl).toHaveBeenCalledWith(cliPath, request.args, expect.objectContaining({
      env: expect.objectContaining({ CLAUDE_CODE_NO_FLICKER: "1" }),
    }));
  });

  it("未标记 noFlicker 时不注入开关", async () => {
    const { requestFile, request, cliPath } = requestFixture();
    const child = new EventEmitter() as ChildProcess;
    // 显式声明 spawn 参数，让 mock.calls 能取到真实子进程环境。
    const spawnImpl = vi.fn((_executable: string, _args: string[], _options: SpawnOptions) => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const running = runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1234, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" }),
    });
    await vi.waitFor(() => expect(fs.existsSync(path.join(request.cwd, `${LEASE_ID}.status.json`))).toBe(true));
    fs.writeFileSync(path.join(request.cwd, `${LEASE_ID}.start`), "", "utf8");
    await running;
    const spawnEnv = spawnImpl.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(spawnEnv).not.toHaveProperty("CLAUDE_CODE_NO_FLICKER");
    expect(spawnImpl).toHaveBeenCalledWith(cliPath, request.args, expect.anything());
  });

  it("非布尔 noFlicker 在启动 CLI 前拒绝", async () => {
    const { requestFile, request } = requestFixture();
    fs.writeFileSync(requestFile, JSON.stringify({ ...request, noFlicker: "yes" }), "utf8");
    const spawnImpl = vi.fn();
    await expect(runTerminalChild(requestFile, {
      spawn: spawnImpl as never,
      identity: async () => ({ pid: 1, executable: "x", startedAt: "2026-11-10T08:00:00.000Z" }),
    })).rejects.toThrow("TERMINAL_CHILD_REQUEST");
    expect(spawnImpl.mock.calls.length).toBe(0);
  });
});
