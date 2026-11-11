import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmbeddedBackend, EmbeddedSession, EmbeddedTerminalAdapter } from "../src/embedded-terminal";
import type { PtyExitEvent, PtyProcess } from "../src/pty-backend";
import type { ServerMessage } from "../src/protocol";

const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "A".repeat(43);
const tempDirs: string[] = [];

interface FakeOwner {
  readyState: number;
  send: ReturnType<typeof vi.fn<(message: ServerMessage) => void>>;
}

/** 创建只含服务端所需 WebSocket 字段的连接替身。 */
function owner(open = true): FakeOwner {
  return { readyState: open ? WebSocket.OPEN : WebSocket.CLOSED, send: vi.fn<(message: ServerMessage) => void>() };
}

/** 创建记录输入、尺寸和 kill 次数的 PTY 替身。 */
function fakePty(): PtyProcess & {
  write: ReturnType<typeof vi.fn<(data: string) => void>>;
  resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>;
  kill: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    pid: 4321,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn(async () => {}),
  };
}

/** 创建带固定随机 token 和可控重连计时器的会话。 */
function session(pty = fakePty(), onTimeout = vi.fn<() => void>()) {
  return {
    pty,
    onTimeout,
    session: new EmbeddedSession(LEASE_ID, pty, onTimeout, {
      issueToken: () => TOKEN,
      bufferLimits: { maxBytes: 8, maxChunks: 8 },
      send: (socket, message) => (socket as unknown as FakeOwner).send(message),
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("内嵌终端原生路线装配", () => {
  it.each(["bun-node-pty", "node-helper"] as const)("只按 manifest 选择已实测路线：%s", (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-embedded-route-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "pty-manifest.json"), JSON.stringify({ backend: kind }), "utf8");
    expect(createEmbeddedBackend(dir).kind).toBe(kind);
  });

  it("manifest 缺失或非法时不在桥接启动阶段抛错，仅 embedded spawn 返回 PTY_UNAVAILABLE", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-embedded-missing-"));
    tempDirs.push(dir);
    const backend = createEmbeddedBackend(dir);
    await expect(backend.spawn({
      file: "C:/fake/claude.exe", args: [], cwd: path.resolve(dir), cols: 80, rows: 24,
    })).rejects.toThrow("PTY_UNAVAILABLE");
    await expect(backend.close()).resolves.toBeUndefined();
    fs.writeFileSync(path.join(dir, "pty-manifest.json"), "not-json", "utf8");
    expect(() => createEmbeddedBackend(dir)).not.toThrow();
  });
});

describe("EmbeddedTerminalAdapter 正常关闭", () => {
  it("等待真实退出和异步退出清理完成后才关闭 backend", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-embedded-close-"));
    tempDirs.push(dir);
    let emitExit: ((event: PtyExitEvent) => void) | undefined;
    const pty: PtyProcess = {
      pid: 4321,
      onData: vi.fn(),
      onExit: vi.fn((callback) => { emitExit = callback; }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {}),
    };
    const backend = {
      kind: "bun-node-pty" as const,
      spawn: vi.fn(async () => pty),
      close: vi.fn(async () => {}),
    };
    const adapter = new EmbeddedTerminalAdapter({
      backend,
      probeVersion: async () => "2.1.316",
      childCommand: { executable: "C:/bridge/ccc-terminal.exe", prefixArgs: [] },
      readIdentity: async () => null,
    });
    const handle = await adapter.start({
      leaseId: LEASE_ID,
      hookToken: "H".repeat(43),
      mode: "embedded",
      folder: dir,
      initialSessionId: LEASE_ID,
      resumeSessionId: LEASE_ID,
      cliPath: path.join(dir, "fake-claude.exe"),
      port: 19280,
      privateDir: path.join(dir, "terminal"),
    });
    let finishCleanup!: () => void;
    let cleanupFinished = false;
    handle.onExit(async () => {
      await new Promise<void>((resolve) => { finishCleanup = resolve; });
      cleanupFinished = true;
    });
    let closed = false;
    const closing = handle.close().then(() => { closed = true; });

    await vi.waitFor(() => expect(pty.kill).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    expect(backend.close).not.toHaveBeenCalled(); // node-helper 仍需存活以接收真实 exit 帧。

    emitExit!({ exitCode: 0, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanupFinished).toBe(false);
    expect(closed).toBe(false);
    expect(backend.close).not.toHaveBeenCalled();

    finishCleanup();
    await closing;
    expect(cleanupFinished).toBe(true);
    expect(closed).toBe(true);
    expect(backend.close).toHaveBeenCalledTimes(1);
  });
});

describe("EmbeddedSession 连接所有权与重放", () => {
  it("初次 attach 前只保留待绑定连接，缓冲输出不发送；attach 后按序重放", () => {
    const f = session();
    const first = owner();
    const other = owner();
    f.session.reserve(first as never);
    expect(f.session.issueAttachToken()).toBe(TOKEN);
    f.session.append("before attach");
    expect(first.send).not.toHaveBeenCalled();
    expect(() => f.session.attach(other as never, TOKEN, 0)).toThrow("NOT_OWNER");
    const replay = f.session.attach(first as never, TOKEN, 0);
    expect(replay).toMatchObject({ gap: false, latestSeq: 1 });
    expect(replay.chunks).toEqual([{ seq: 1, data: "before attach" }]);
    f.session.append("after attach");
    expect(first.send).toHaveBeenCalledWith({
      type: "terminal.output", leaseId: LEASE_ID, seq: 2, data: "after attach",
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  it("只有 attached owner 可以写入和 resize，错误 token 不能窃取连接", () => {
    const f = session();
    const first = owner();
    const second = owner();
    f.session.reserve(first as never);
    f.session.issueAttachToken();
    f.session.attach(first as never, TOKEN, 0);
    expect(() => f.session.attach(second as never, TOKEN, 0)).toThrow("NOT_OWNER");
    expect(() => f.session.write(second as never, "bad")).toThrow("ATTACH_REQUIRED");
    expect(() => f.session.resize(second as never, 132, 36)).toThrow("ATTACH_REQUIRED");
    expect(f.pty.write).not.toHaveBeenCalled();
    expect(f.pty.resize).not.toHaveBeenCalled();
    f.session.write(first as never, "中文\r");
    f.session.resize(first as never, 132, 36);
    expect(f.pty.write).toHaveBeenCalledWith("中文\r");
    expect(f.pty.resize).toHaveBeenCalledWith(132, 36);
  });

  it("2999ms 不 kill，3000ms 超时只回调一次；原 token 可在期限内重连", async () => {
    vi.useFakeTimers();
    const f = session();
    const first = owner();
    f.session.reserve(first as never);
    f.session.issueAttachToken();
    f.session.attach(first as never, TOKEN, 0);
    f.session.detach(first as never);
    f.session.append("offline");
    await vi.advanceTimersByTimeAsync(2999);
    expect(f.onTimeout).not.toHaveBeenCalled();
    const replacement = owner();
    const replay = f.session.attach(replacement as never, TOKEN, 0);
    expect(replay.chunks).toEqual([{ seq: 1, data: "offline" }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.onTimeout).not.toHaveBeenCalled();
    f.session.detach(replacement as never);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.onTimeout).toHaveBeenCalledTimes(1);
  });

  it("旧游标遇到缓冲缺口时明确返回 gap，不伪造连续输出", () => {
    const f = session();
    f.session.reserve(owner() as never);
    f.session.issueAttachToken();
    f.session.append("1111");
    f.session.append("2222");
    f.session.append("3333");
    expect(f.session.buffer.since(0)).toMatchObject({ gap: true, latestSeq: 3 });
  });

  it("close 清掉 owner、token、计时器和缓冲，但 seq 不回退", async () => {
    vi.useFakeTimers();
    const f = session();
    const first = owner();
    f.session.reserve(first as never);
    f.session.issueAttachToken();
    f.session.attach(first as never, TOKEN, 0);
    f.session.detach(first as never);
    await f.session.close();
    expect(f.pty.kill).toHaveBeenCalledTimes(1);
    expect(f.session.buffer.since(0).gap).toBe(false);
    expect(() => f.session.attach(first as never, TOKEN, 0)).toThrow("NOT_OWNER");
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.onTimeout).not.toHaveBeenCalled();
  });
});
