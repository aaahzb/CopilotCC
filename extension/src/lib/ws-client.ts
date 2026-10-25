import type { ClientMessage, ServerMessage } from "./protocol";

/** 连接状态（UI 状态灯用） */
export type ConnState = "connecting" | "open" | "closed";

/** BridgeClient 构造参数。WebSocketImpl 仅供测试注入。 */
export interface BridgeClientOpts {
  getUrl(): string;
  onMessage(m: ServerMessage): void;
  onState(s: ConnState): void;
  /** auth.ok 交给界面处理后，按序发送启动消息（完整设置必须先于 client.ready 触发快照/工作区恢复） */
  getHelloMessages?(): ClientMessage[];
  WebSocketImpl?: unknown;
}

/** WS 客户端：断线指数退避重连（1s 起步翻倍，上限 30s），未连接时消息入队待发 */
export class BridgeClient {
  private ws: { readyState: number; send(d: string): void; close(): void; onopen: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null } | null = null;
  private queue: ClientMessage[] = [];
  private retries = 0;
  private closedByUser = false;

  /**
   * @param opts 连接参数与回调
   */
  constructor(private readonly opts: BridgeClientOpts) {}

  /** 建立连接；断线自动重连直到 close() */
  connect(): void {
    this.closedByUser = false;
    this.opts.onState("connecting");
    const Impl = (this.opts.WebSocketImpl ?? WebSocket) as new (url: string) => NonNullable<BridgeClient["ws"]>;
    const ws = new Impl(this.opts.getUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.opts.onState("open");
      for (const m of this.queue.splice(0)) this.send(m);
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data) as ServerMessage;
        this.opts.onMessage(m);
        if (m.type === "auth.ok") {
          for (const hello of this.opts.getHelloMessages?.() ?? []) this.send(hello);
        }
      } catch {
        // 忽略坏帧
      }
    };
    ws.onclose = () => {
      this.opts.onState("closed");
      if (!this.closedByUser) {
        const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
        setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // 已关闭
      }
    };
  }

  /**
   * 发送消息；连接未就绪时入队，open 后自动冲刷。
   * @param m 客户端消息
   */
  send(m: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(m));
    } else {
      this.queue.push(m);
    }
  }

  /** 主动关闭，不再重连 */
  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
