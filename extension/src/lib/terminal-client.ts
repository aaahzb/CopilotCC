import { BridgeClient } from "./ws-client";
import type { ClientMessage, ServerMessage, TerminalPublicState } from "./protocol";

/** 终端页可渲染的公开状态，不包含 attachToken 或配对信息。 */
export interface TerminalClientView {
  phase: "connecting" | "opening" | "attaching" | "attached" | "reconnecting" | "stopping" | "exited" | "error";
  message: string;
  terminal: TerminalPublicState | null;
  exitCode: number | null;
}

/** TerminalClient 的输入、输出和生命周期回调。 */
export interface TerminalClientOptions {
  getUrl(): string;
  write(data: string): void;
  onView(view: TerminalClientView): void;
  onAttached?(): void;
  WebSocketImpl?: unknown;
}

interface LeaseMemory {
  leaseId: string;
  attachToken: string;
  lastSeq: number;
}

/**
 * 独立终端页协议客户端。
 * lease/token/seq 仅存在于本页面实例内存；断线后由 BridgeClient 重连，
 * auth.ok 的动态 hello 闭包只 attach 原 lease，绝不重新 open 第二个写入者。
 */
export class TerminalClient {
  private readonly bridge: BridgeClient;
  private lease: LeaseMemory | null = null;
  private openRequested = false;
  private attached = false;
  private closeSent = false;
  private terminated = false;
  private view: TerminalClientView = {
    phase: "connecting", message: "正在连接本机桥接…", terminal: null, exitCode: null,
  };

  /** @param options 桥接地址、xterm 写入与页面状态回调 */
  constructor(private readonly options: TerminalClientOptions) {
    this.bridge = new BridgeClient({
      getUrl: options.getUrl,
      WebSocketImpl: options.WebSocketImpl,
      onMessage: (message) => this.onMessage(message),
      onState: (state) => this.onConnectionState(state),
      getHelloMessages: () => this.helloMessages(),
    });
  }

  /** 建立连接；认证前不会发送 terminal.open。 */
  connect(): void { this.bridge.connect(); }

  /** @returns 当前已连续写入 xterm 的最大输出序号 */
  lastSeq(): number { return this.lease?.lastSeq ?? 0; }

  /** @returns 是否已收到当前连接的 terminal.attached */
  isAttached(): boolean { return this.attached && !this.closeSent && !this.terminated; }

  /**
   * 写入真实 PTY 输入。
   * @param data xterm 原始输入（含中文与组合输入提交结果）
   */
  input(data: string): void {
    if (!this.isAttached() || !this.lease) return;
    this.bridge.send({ type: "terminal.input", leaseId: this.lease.leaseId, data });
  }

  /**
   * 调整真实 PTY 行列。
   * @param cols xterm fit 后列数
   * @param rows xterm fit 后行数
   */
  resize(cols: number, rows: number): void {
    if (!this.isAttached() || !this.lease) return;
    this.bridge.send({ type: "terminal.resize", leaseId: this.lease.leaseId, cols, rows });
  }

  /** 明确结束后端但保留连接，以展示真实 terminal.exit。 */
  stop(): void {
    if (!this.lease || this.closeSent || this.terminated) return;
    this.closeSent = true;
    this.attached = false;
    this.bridge.send({ type: "terminal.close", leaseId: this.lease.leaseId });
    this.setView({ phase: "stopping", message: "正在结束终端…" });
  }

  /** 页面卸载：至多发送一次 close，并立即停用自动重连；token 不写任何存储。 */
  closePage(): void {
    if (this.terminated) return;
    if (this.lease && !this.closeSent) {
      this.closeSent = true;
      this.bridge.send({ type: "terminal.close", leaseId: this.lease.leaseId });
    }
    this.terminated = true;
    this.attached = false;
    this.bridge.close();
  }

  /** React 清理：仅断开连接；pagehide 已负责发送终端结束请求。 */
  close(): void {
    this.terminated = true;
    this.attached = false;
    this.bridge.close();
  }

  /** @returns 本次认证后的启动帧；lease 存在时只恢复原连接 */
  private helloMessages(): ClientMessage[] {
    if (this.terminated || this.closeSent) return [];
    if (this.lease) {
      this.setView({ phase: "attaching", message: "正在恢复终端输出…" });
      return [{
        type: "terminal.attach", leaseId: this.lease.leaseId,
        attachToken: this.lease.attachToken, afterSeq: this.lease.lastSeq,
      }];
    }
    if (this.openRequested) return [];
    this.openRequested = true;
    this.setView({ phase: "opening", message: "正在启动插件终端…" });
    return [{ type: "terminal.open", mode: "embedded" }];
  }

  /** @param state BridgeClient 连接状态 */
  private onConnectionState(state: "connecting" | "open" | "closed"): void {
    if (this.terminated) return;
    if (state === "closed") {
      this.attached = false;
      if (!this.lease) this.openRequested = false;
      this.setView({ phase: "reconnecting", message: "连接中断，3 秒内尝试恢复" });
    } else if (state === "connecting") {
      this.setView({ phase: "connecting", message: "正在连接本机桥接…" });
    } else {
      this.setView({ phase: "connecting", message: "正在认证…" });
    }
  }

  /** @param message 桥接服务消息 */
  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "terminal.opened": {
        if (message.mode !== "embedded" || !message.attachToken || this.lease || this.closeSent) return;
        this.lease = { leaseId: message.leaseId, attachToken: message.attachToken, lastSeq: 0 };
        this.setView({ phase: "attaching", message: "正在接入终端输出…" });
        this.bridge.send({
          type: "terminal.attach", leaseId: message.leaseId,
          attachToken: message.attachToken, afterSeq: 0,
        });
        break;
      }
      case "terminal.attached": {
        if (!this.lease || message.leaseId !== this.lease.leaseId || this.closeSent) return;
        if (message.replayGap) {
          this.fail("终端输出无法完整重放，正在结束终端", true);
          return;
        }
        this.attached = true;
        this.setView({ phase: "attached", message: "终端已连接" });
        this.options.onAttached?.();
        break;
      }
      case "terminal.output": {
        if (!this.lease || message.leaseId !== this.lease.leaseId || !this.attached || this.closeSent) return;
        if (message.seq <= this.lease.lastSeq) return; // 重放/重连重复块不重复写屏。
        if (message.seq !== this.lease.lastSeq + 1) {
          this.fail("输出序号不连续，正在结束终端", true);
          return;
        }
        this.options.write(message.data);
        this.lease.lastSeq = message.seq;
        break;
      }
      case "terminal.state":
        this.setView({ terminal: message.state });
        break;
      case "terminal.exit": {
        if (!this.lease || message.leaseId !== this.lease.leaseId) return;
        const exitMessage = `终端已退出（${message.reason}）`;
        const hadError = this.view.phase === "error";
        this.terminated = true;
        this.attached = false;
        this.setView({
          // 缺帧等致命错误后的退出是清理结果，不能用通用退出文案覆盖根因。
          phase: hadError ? "error" : "exited",
          message: hadError ? `${this.view.message}；${exitMessage}` : exitMessage,
          exitCode: message.exitCode,
        });
        this.bridge.close();
        break;
      }
      case "terminal.error": {
        if (message.leaseId && this.lease && message.leaseId !== this.lease.leaseId) return;
        const fatal = message.code === "OUTPUT_GAP" || message.code === "DETACHED"
          || message.code === "ATTACH_REQUIRED" || message.code === "NOT_OWNER";
        this.fail(message.message, fatal);
        break;
      }
      case "auth.fail":
        this.fail(`桥接认证失败：${message.reason}`, false);
        break;
      default:
        break;
    }
  }

  /** @param patch 公开视图增量 */
  private setView(patch: Partial<TerminalClientView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onView(this.view);
  }

  /**
   * 显示错误；协议连续性/所有权错误同时结束后端。
   * @param message 不含秘密的固定错误说明
   * @param closeBackend 是否发送 terminal.close
   */
  private fail(message: string, closeBackend: boolean): void {
    if (closeBackend) this.stop();
    else this.terminated = true;
    this.attached = false;
    this.setView({ phase: "error", message });
  }
}
