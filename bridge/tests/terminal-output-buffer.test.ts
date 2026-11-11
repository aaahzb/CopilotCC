import { describe, expect, it } from "vitest";
import { TerminalOutputBuffer } from "../src/terminal-output-buffer";

describe("TerminalOutputBuffer", () => {
  it("seq 连续，按 afterSeq 重放且不错发前一块", () => {
    const buffer = new TerminalOutputBuffer({ maxBytes: 1024, maxChunks: 4 });
    expect(buffer.append("")).toBeNull();
    expect(buffer.append("a")!.seq).toBe(1);
    buffer.append("中文");
    expect(buffer.since(1)).toEqual({ gap: false, latestSeq: 2, chunks: [{ seq: 2, data: "中文" }] });
    expect(buffer.since(2)).toEqual({ gap: false, latestSeq: 2, chunks: [] });
    expect(() => buffer.since(3)).toThrow("FUTURE_SEQ");
    expect(() => buffer.since(-1)).toThrow("FUTURE_SEQ");
    expect(() => buffer.since(1.5)).toThrow("FUTURE_SEQ");
  });

  it("超过字节/块数限制报告缺口，未来 attach 不错误接受", () => {
    const buffer = new TerminalOutputBuffer({ maxBytes: 8, maxChunks: 2 });
    buffer.append("1234");
    buffer.append("5678");
    buffer.append("90");
    expect(buffer.since(0).gap).toBe(true);
    expect(buffer.since(0).chunks.map((chunk) => chunk.seq)).toEqual([2, 3]);
    expect(buffer.since(1).gap).toBe(false);
    expect(buffer.latestSeq()).toBe(3);
    expect(() => buffer.since(4)).toThrow("FUTURE_SEQ");
  });

  it("单块超过字节上限仍完整保留，不截断 UTF-8 字符串", () => {
    const buffer = new TerminalOutputBuffer({ maxBytes: 2, maxChunks: 2 });
    const data = "中文🙂";
    expect(buffer.append(data)).toEqual({ seq: 1, data });
    expect(buffer.since(0)).toEqual({ gap: false, latestSeq: 1, chunks: [{ seq: 1, data }] });
  });

  it("clear 不复用 seq，清空期间的旧游标必须报告缺口", () => {
    const buffer = new TerminalOutputBuffer({ maxBytes: 1024, maxChunks: 4 });
    buffer.append("a");
    buffer.clear();
    expect(buffer.latestSeq()).toBe(1);
    expect(buffer.since(0)).toEqual({ gap: true, latestSeq: 1, chunks: [] });
    expect(buffer.since(1)).toEqual({ gap: false, latestSeq: 1, chunks: [] });
    expect(buffer.append("b")!.seq).toBe(2);
    expect(buffer.since(1).gap).toBe(false);
    expect(buffer.since(0).gap).toBe(true);
  });
});
