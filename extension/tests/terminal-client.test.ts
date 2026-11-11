/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalClient, type TerminalClientView } from "../src/lib/terminal-client";
import type { ServerMessage } from "../src/lib/protocol";

const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "A".repeat(43);

/** 可控 WebSocket，保留真实 BridgeClient 的认证和重连机制。 */
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) { FakeWS.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  push(message: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  messages(): Array<{ type: string; [key: string]: unknown }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string });
  }
}

/** 创建真实终端客户端及记录型输出/视图。 */
function fixture(): {
  client: TerminalClient;
  writes: string[];
  views: TerminalClientView[];
  host: HTMLDivElement;
  attached: number;
} {
  const writes: string[] = [];
  const views: TerminalClientView[] = [];
  const host = document.createElement("div");
  let attached = 0;
  const client = new TerminalClient({
    getUrl: () => "ws://127.0.0.1:1/ws?token=test",
    write: (data) => writes.push(data),
    onView: (view) => { views.push(view); host.textContent = view.message; },
    onAttached: () => { attached += 1; },
    WebSocketImpl: FakeWS,
  });
  client.connect();
  return { client, writes, views, host, get attached() { return attached; } };
}

/** 完成认证、open 和 attach，返回当前连接。 */
function attach(client: TerminalClient): FakeWS {
  const ws = FakeWS.instances.at(-1);
  if (!ws) throw new Error("缺少 WebSocket");
  ws.open();
  ws.push({ type: "auth.ok" });
  ws.push({ type: "terminal.opened", leaseId: LEASE_ID, mode: "embedded", backend: "pty", attachToken: TOKEN });
  ws.push({ type: "terminal.attached", leaseId: LEASE_ID, replayGap: false, latestSeq: 0 });
  return ws;
}

beforeEach(() => { FakeWS.instances = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("TerminalClient 认证、输出和重连", () => {
  it("auth.ok 前不 open，opened 前不 attach，opened 后在同一连接 attach", () => {
    const f = fixture();
    const ws = FakeWS.instances[0]!;
    expect(ws.messages()).toEqual([]);
    ws.open();
    expect(ws.messages().map((m) => m.type)).not.toContain("terminal.open");
    ws.push({ type: "auth.ok" });
    expect(ws.messages()).toEqual([{ type: "terminal.open", mode: "embedded" }]);
    ws.push({ type: "terminal.opened", leaseId: LEASE_ID, mode: "embedded", backend: "pty", attachToken: TOKEN });
    expect(ws.messages()[1]).toEqual({ type: "terminal.attach", leaseId: LEASE_ID, attachToken: TOKEN, afterSeq: 0 });
    expect(f.views.at(-1)?.phase).toBe("attaching");
    f.client.close();
  });

  it("输入带 leaseId，resize 使用 fit 行列，连续输出按 seq 写入且 attached 后回调", () => {
    const f = fixture();
    const ws = attach(f.client);
    expect(f.attached).toBe(1);
    f.client.input("中文\r");
    f.client.resize(132, 36);
    ws.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 1, data: "第一" });
    ws.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 2, data: "第二" });
    expect(f.writes).toEqual(["第一", "第二"]);
    expect(f.client.lastSeq()).toBe(2);
    expect(ws.messages()).toContainEqual({ type: "terminal.input", leaseId: LEASE_ID, data: "中文\r" });
    expect(ws.messages()).toContainEqual({ type: "terminal.resize", leaseId: LEASE_ID, cols: 132, rows: 36 });
    f.client.close();
  });

  it("重连 auth.ok 后只 attach 同一 token/lastSeq，不重新 open", () => {
    const f = fixture();
    const first = attach(f.client);
    first.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 1, data: "保留" });
    first.close();
    vi.advanceTimersByTime(1000);
    const second = FakeWS.instances[1]!;
    second.open();
    expect(second.messages().map((m) => m.type)).not.toContain("terminal.open");
    second.push({ type: "auth.ok" });
    expect(second.messages()).toEqual([{ type: "terminal.attach", leaseId: LEASE_ID, attachToken: TOKEN, afterSeq: 1 }]);
    second.push({ type: "terminal.attached", leaseId: LEASE_ID, replayGap: false, latestSeq: 1 });
    expect(f.attached).toBe(2);
    f.client.close();
  });

  it("重复 seq 忽略，缺口明确报错并发送 close，不写入伪造连续屏幕", () => {
    const f = fixture();
    const ws = attach(f.client);
    ws.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 1, data: "正确" });
    ws.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 1, data: "重复" });
    expect(f.writes).toEqual(["正确"]);
    ws.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 3, data: "缺失" });
    expect(f.writes).toEqual(["正确"]);
    expect(f.host.textContent).toContain("输出序号不连续，正在结束终端");
    expect(ws.messages().at(-1)).toEqual({ type: "terminal.close", leaseId: LEASE_ID });
    expect(f.views.at(-1)?.phase).toBe("error");
  });

  it("输出缺口后的真实退出保留错误原因和退出码", () => {
    const f = fixture();
    const ws = attach(f.client);
    ws.push({ type: "terminal.output", leaseId: LEASE_ID, seq: 2, data: "缺失" });
    expect(f.views.at(-1)?.phase).toBe("error");
    ws.push({ type: "terminal.exit", leaseId: LEASE_ID, reason: "exit", exitCode: 1 });
    expect(f.views.at(-1)).toMatchObject({
      phase: "error",
      exitCode: 1,
    });
    expect(f.host.textContent).toContain("输出序号不连续");
    expect(f.host.textContent).toContain("终端已退出（exit）");
  });

  it("replayGap 在写任何重放数据前结束终端", () => {
    const f = fixture();
    const ws = FakeWS.instances[0]!;
    ws.open();
    ws.push({ type: "auth.ok" });
    ws.push({ type: "terminal.opened", leaseId: LEASE_ID, mode: "embedded", backend: "pty", attachToken: TOKEN });
    ws.push({ type: "terminal.attached", leaseId: LEASE_ID, replayGap: true, latestSeq: 8 });
    expect(f.host.textContent).toContain("终端输出无法完整重放");
    expect(f.writes).toEqual([]);
    expect(ws.messages().at(-1)).toEqual({ type: "terminal.close", leaseId: LEASE_ID });
  });
});
