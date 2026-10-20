import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BridgeClient, type ConnState } from "../src/lib/ws-client";
import type { ClientMessage, ServerMessage } from "../src/lib/protocol";

/** 假 WebSocket：记录实例与发送帧，测试手动触发生命周期事件 */
class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string): void { this.sent.push(d); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  // 测试辅助
  open(): void { this.readyState = 1; this.onopen?.(); }
  push(m: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(m) }); }
}

beforeEach(() => { FakeWS.instances = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function makeClient() {
  const states: ConnState[] = [];
  const received: ServerMessage[] = [];
  const c = new BridgeClient({
    getUrl: () => "ws://127.0.0.1:1/ws?token=t",
    onMessage: (m) => received.push(m),
    onState: (s) => states.push(s),
    WebSocketImpl: FakeWS,
  });
  return { c, states, received };
}

describe("BridgeClient", () => {
  it("open 前 send 入队，open 后冲刷", () => {
    const { c } = makeClient();
    c.connect();
    c.send({ type: "client.ready" });
    expect(FakeWS.instances[0]!.sent.length).toBe(0);
    FakeWS.instances[0]!.open();
    expect(FakeWS.instances[0]!.sent.length).toBe(1);
    expect(JSON.parse(FakeWS.instances[0]!.sent[0]!)).toEqual({ type: "client.ready" });
    c.close();
  });

  it("收到帧解析为 ServerMessage 回调", () => {
    const { c, received } = makeClient();
    c.connect();
    FakeWS.instances[0]!.open();
    FakeWS.instances[0]!.push({ type: "auth.ok" });
    expect(received).toEqual([{ type: "auth.ok" }]);
    c.close();
  });

  it("断线后指数退避重连，close() 后不再重连", () => {
    const { c, states } = makeClient();
    c.connect();
    const first = FakeWS.instances[0]!;
    first.open();
    first.close(); // 模拟断开
    expect(FakeWS.instances.length).toBe(1);
    vi.advanceTimersByTime(1000); // 第一次退避 1s
    expect(FakeWS.instances.length).toBe(2);
    FakeWS.instances[1]!.close();
    vi.advanceTimersByTime(2000); // 第二次退避 2s
    expect(FakeWS.instances.length).toBe(3);
    c.close();
    const n = FakeWS.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances.length).toBe(n); // 不再重连
    expect(states).toContain("closed");
  });
});
