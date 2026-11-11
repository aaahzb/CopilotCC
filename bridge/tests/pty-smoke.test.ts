import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { runPtySmoke } from "../src/pty-smoke";
import type { PtyBackend, PtyExitEvent, PtyProcess } from "../src/pty-backend";

/** 可脚本化的 PTY，仅替代原生层，实际执行生产 smoke 的输入与断言顺序。 */
function scriptedBackend(exitCode = 7): {
  backend: PtyBackend;
  pty: PtyProcess & { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: ((event: PtyExitEvent) => void) | undefined;
  const pty = {
    pid: 4321,
    onData: (callback: (data: string) => void): void => {
      dataCallback = callback;
      callback("SIZE:80x24\n");
      for (let tick = 1; tick <= 5; tick += 1) callback(`TICK:${tick}\n`);
    },
    onExit: (callback: (event: PtyExitEvent) => void): void => { exitCallback = callback; },
    write: vi.fn((data: string) => {
      if (data === "ECHO\r") dataCallback?.("中文输出:你好\n");
      if (data === "EXIT\r") exitCallback?.({ exitCode, signal: null });
    }),
    resize: vi.fn(() => dataCallback?.("SIZE:132x36\n")),
    kill: vi.fn(async () => {}),
  };
  const close = vi.fn(async () => {});
  return { backend: { kind: "bun-node-pty", spawn: vi.fn(async () => pty), close }, pty, close };
}

describe("显式 PTY 行为 smoke", () => {
  it("按初始尺寸、中文输入、五个 tick、resize 和退出码 7 驱动真实后端", async () => {
    const f = scriptedBackend();
    const result = await runPtySmoke({
      expectedPlatform: process.platform,
      expectedArch: process.arch,
      cliPath: path.resolve("isolated/fake-claude.exe"),
      executableDir: "C:/isolated/bridge",
      backend: f.backend,
    });
    expect(result).toMatchObject({
      initialSize: true, inputEcho: true, continuousTicks: true,
      chinese: true, resize: true, exitCode7: true,
    });
    expect(f.pty.write.mock.calls.map(([data]) => data)).toEqual(["ECHO\r", "EXIT\r"]);
    expect(f.pty.resize).toHaveBeenCalledWith(132, 36);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("平台不匹配时不读取命令或启动原生后端", async () => {
    const f = scriptedBackend();
    await expect(runPtySmoke({
      expectedPlatform: process.platform === "win32" ? "darwin" : "win32",
      expectedArch: process.arch,
      cliPath: path.resolve("isolated/fake-claude.exe"),
      executableDir: "C:/isolated/bridge",
      backend: f.backend,
    })).rejects.toThrow("PTY_SMOKE_PLATFORM_MISMATCH");
    expect(f.pty.write).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("行为失败仍关闭后端，不能把非 7 退出码记作通过", async () => {
    const f = scriptedBackend(0);
    await expect(runPtySmoke({
      expectedPlatform: process.platform,
      expectedArch: process.arch,
      cliPath: path.resolve("isolated/fake-claude.exe"),
      executableDir: "C:/isolated/bridge",
      backend: f.backend,
    })).rejects.toThrow("PTY_SMOKE_EXIT_0");
    expect(f.close).toHaveBeenCalledOnce();
  });
});
