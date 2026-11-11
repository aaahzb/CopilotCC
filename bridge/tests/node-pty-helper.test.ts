import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHelperRequest, runNodePtyHelper } from "../src/node-pty-helper";
import type { PtySpawnOptions } from "../src/pty-backend";

const streams: PassThrough[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
});

function options(): PtySpawnOptions {
  return {
    file: "C:/runtime/node.exe",
    args: ["child.cjs"],
    cwd: "C:/work",
    cols: 80,
    rows: 24,
    env: { ONLY_TEST: "yes" },
  };
}

function fakePty() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pid: 7654,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(callback: (data: string) => void) { onData = callback; return { dispose: () => undefined }; },
    onExit(callback: (event: { exitCode: number; signal?: number }) => void) { onExit = callback; return { dispose: () => undefined }; },
    emitData(data: string) { onData?.(data); },
    emitExit(exitCode: number) { onExit?.({ exitCode }); },
  };
}

function helperFixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  streams.push(input, output);
  let raw = "";
  output.on("data", (chunk) => { raw += chunk.toString("utf8"); });
  const pty = fakePty();
  const spawn = vi.fn(() => pty);
  runNodePtyHelper({ input, output, pty: { spawn } as never });
  return {
    input,
    pty,
    spawn,
    send(value: unknown) { input.write(`${JSON.stringify(value)}\n`); },
    frames() { return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); },
    raw() { return raw; },
  };
}

describe("node-pty helper 协议", () => {
  it("start 前拒绝相对 cwd、非法尺寸和非字符串参数", () => {
    expect(() => parseHelperRequest({ type: "start", id: 1, options: { ...options(), cwd: "relative" } }))
      .toThrow("INVALID_REQUEST");
    expect(() => parseHelperRequest({ type: "start", id: 1, options: { ...options(), cols: 1 } }))
      .toThrow("INVALID_REQUEST");
    expect(() => parseHelperRequest({ type: "start", id: 1, options: { ...options(), args: ["ok", 2] } }))
      .toThrow("INVALID_REQUEST");
  });

  it("真实适配器保留多行中文、输入、resize 和退出帧", async () => {
    const fixture = helperFixture();
    fixture.send({ type: "start", id: 1, options: options() });
    await vi.waitFor(() => expect(fixture.frames()).toContainEqual({ type: "started", id: 1, pid: 7654 }));
    expect(fixture.spawn).toHaveBeenCalledWith(options().file, options().args, expect.objectContaining({
      cwd: options().cwd, env: options().env, cols: 80, rows: 24,
    }));

    fixture.pty.emitData("第一行\r\n第二行");
    fixture.send({ type: "write", id: 1, data: "中文\r" });
    fixture.send({ type: "resize", id: 1, cols: 132, rows: 36 });
    await vi.waitFor(() => {
      expect(fixture.frames()).toContainEqual({ type: "data", id: 1, data: "第一行\r\n第二行" });
      expect(fixture.pty.write).toHaveBeenCalledWith("中文\r");
      expect(fixture.pty.resize).toHaveBeenCalledWith(132, 36);
    });
    fixture.pty.emitExit(7);
    await vi.waitFor(() => expect(fixture.frames()).toContainEqual({ type: "exit", id: 1, exitCode: 7, signal: null }));
  });

  it("单帧超过 1 MiB 时明确报错且不启动 PTY", async () => {
    const fixture = helperFixture();
    fixture.input.write("x".repeat(1_048_577));
    await vi.waitFor(() => expect(fixture.frames()).toContainEqual(expect.objectContaining({
      type: "error", id: null, code: "FRAME_TOO_LARGE",
    })));
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it("start 异常定向返回错误，stdout 不混入非协议日志", async () => {
    const fixture = helperFixture();
    fixture.spawn.mockImplementation(() => { throw new Error("spawn failed"); });
    fixture.send({ type: "start", id: 9, options: options() });
    await vi.waitFor(() => expect(fixture.frames()).toContainEqual(expect.objectContaining({
      type: "error", id: 9, code: "SPAWN_FAILED",
    })));
    expect(fixture.raw().split("\n").filter(Boolean)).toHaveLength(1);
  });
});
