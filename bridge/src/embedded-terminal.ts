import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { WebSocket as WebSocketState } from "ws";
import { encode, type ServerMessage } from "./protocol";
import { probeCliVersion, selectHookTransport } from "./cli-capabilities";
import { terminalChildCommand, terminalHookCommand, terminalNativeDirectory, type TerminalChildCommand } from "./runtime-entry";
import { safeTokenEqual, writeTerminalSettings } from "./terminal-hooks";
import { readProcessIdentity } from "./process-identity";
import type {
  ProcessIdentity,
  TerminalLeaseRecord,
  TerminalRuntimeHandle,
  TerminalStartContext,
} from "./terminal-lease";
import { TerminalOutputBuffer, type ReplayPage, type TerminalOutputBufferLimits } from "./terminal-output-buffer";
import { createPtyBackend, type PtyBackend, type PtyProcess } from "./pty-backend";

/** EmbeddedSession 的可注入边界；生产只使用随机 token、真实 WS 和 3 秒默认值。 */
export interface EmbeddedSessionOptions {
  issueToken?: () => string;
  reconnectMs?: number;
  bufferLimits?: TerminalOutputBufferLimits;
  send?: (socket: WebSocket, message: ServerMessage) => void;
}

/** 内嵌终端运行时句柄，额外携带仅供 TerminalService 使用的连接会话。 */
export interface EmbeddedTerminalHandle extends TerminalRuntimeHandle {
  readonly session: EmbeddedSession;
  close(): Promise<void>;
}

/** EmbeddedTerminalAdapter 的原生与 Hook 依赖。 */
export interface EmbeddedTerminalDeps {
  backend: PtyBackend;
  probeVersion?: (cliPath: string) => Promise<string>;
  childCommand?: TerminalChildCommand;
  /** 启动后查询真实 PID、程序路径和 OS 启动时间；失败时保持未知而非猜测 */
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  reconnectMs?: number;
  bufferLimits?: TerminalOutputBufferLimits;
}

/**
 * 一个 PTY lease 的屏幕缓冲和唯一连接所有权。
 * token 只留在内存；真实进程退出前，断开连接不会释放终端 lease。
 */
export class EmbeddedSession {
  readonly buffer: TerminalOutputBuffer;
  private readonly issueToken: () => string;
  private readonly reconnectMs: number;
  private readonly send: (socket: WebSocket, message: ServerMessage) => void;
  private pendingOwner: WebSocket | null = null;
  private owner: WebSocket | null = null;
  private attachToken: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private hasAttached = false;
  private stopping = false;
  private ended = false;
  private closed = false;

  /**
   * @param leaseId 当前唯一终端 lease。
   * @param pty 已启动的真实伪终端。
   * @param onTimeout 重连宽限耗尽后的停止回调。
   * @param options 测试用随机数、计时和传输替身。
   */
  constructor(
    readonly leaseId: string,
    private readonly pty: PtyProcess,
    private readonly onTimeout: () => void,
    options: EmbeddedSessionOptions = {},
  ) {
    this.buffer = new TerminalOutputBuffer(options.bufferLimits);
    this.issueToken = options.issueToken ?? (() => randomBytes(32).toString("base64url"));
    this.reconnectMs = options.reconnectMs ?? 3000;
    this.send = options.send ?? ((socket, message) => {
      if (socket.readyState === WebSocketState.OPEN) socket.send(encode(message));
    });
  }

  /**
   * 在 opened 前保留发起连接的初次 attach 权。
   * @param ws 发起 terminal.open 的连接。
   */
  reserve(ws: WebSocket): void {
    if (this.closed || this.ended || this.owner || this.pendingOwner) throw new Error("NOT_OWNER");
    this.pendingOwner = ws;
  }

  /**
   * 生成仅通过定向 terminal.opened 返回的一次性页面凭据。
   * @returns 43 位 base64url attachToken。
   */
  issueAttachToken(): string {
    if (this.closed || this.ended) throw new Error("DETACHED");
    this.attachToken = this.issueToken();
    return this.attachToken;
  }

  /**
   * 校验 pending owner、attachToken 和当前连接，再返回待重放块。
   * @param ws 请求绑定的连接。
   * @param token 页面内存中的 attachToken。
   * @param afterSeq 页面已确认的连续序号。
   * @returns 重放页；gap=true 时调用方必须终止而不是发送 chunks。
   * @throws NOT_OWNER 或 FUTURE_SEQ。
   */
  attach(ws: WebSocket, token: string, afterSeq: number): ReplayPage {
    if (this.closed || this.ended || !this.attachToken || !safeTokenEqual(token, this.attachToken)) {
      throw new Error("NOT_OWNER");
    }
    if (this.owner && this.owner !== ws && this.owner.readyState === WebSocketState.OPEN) {
      throw new Error("NOT_OWNER");
    }
    if (!this.hasAttached && this.pendingOwner && this.pendingOwner !== ws
      && this.pendingOwner.readyState === WebSocketState.OPEN) {
      throw new Error("NOT_OWNER");
    }
    const replay = this.buffer.since(afterSeq);
    this.clearReconnectTimer();
    this.owner = ws;
    this.pendingOwner = ws;
    this.hasAttached = true;
    return replay;
  }

  /**
   * 仅对当前 owner 或尚未初次 attach 的发起连接启动 3 秒宽限。
   * 普通聊天连接调用本方法不会产生副作用。
   * @param ws 已断开的连接。
   */
  detach(ws: WebSocket): void {
    if (this.closed || this.ended || (this.owner !== ws && this.pendingOwner !== ws)) return;
    if (this.owner === ws) this.owner = null;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && !this.ended && !this.owner) this.onTimeout();
    }, this.reconnectMs);
    this.reconnectTimer.unref();
  }

  /**
   * 写入已绑定 owner 的键盘输入。
   * @param ws 请求连接。
   * @param data 严格协议已限制大小的 UTF-8 输入。
   * @throws ATTACH_REQUIRED 非当前 owner 或连接已关闭。
   */
  write(ws: WebSocket, data: string): void {
    this.assertAttached(ws);
    this.pty.write(data);
  }

  /**
   * 调整真实 PTY 尺寸。
   * @param ws 请求连接。
   * @param cols 列数。
   * @param rows 行数。
   * @throws ATTACH_REQUIRED 非当前 owner 或连接已关闭。
   */
  resize(ws: WebSocket, cols: number, rows: number): void {
    this.assertAttached(ws);
    this.pty.resize(cols, rows);
  }

  /**
   * 输出先进入统一有界缓冲，再仅镜像给当前 owner。
   * @param data PTY 原始 ANSI 字符串。
   */
  append(data: string): void {
    if (this.closed || this.ended || this.stopping) return;
    const chunk = this.buffer.append(data);
    if (!chunk || !this.owner || this.owner.readyState !== WebSocketState.OPEN) return;
    this.send(this.owner, {
      type: "terminal.output", leaseId: this.leaseId, seq: chunk.seq, data: chunk.data,
    });
  }

  /**
   * 向仍可接收的 owner 发送真实退出帧，并禁止后续 attach。
   * @param exitCode PTY 退出码。
   * @param reason 固定退出原因。
   */
  exit(exitCode: number | null, reason: string): void {
    if (this.ended || this.closed) return;
    this.ended = true;
    this.clearReconnectTimer();
    if (this.owner && this.owner.readyState === WebSocketState.OPEN) {
      this.send(this.owner, { type: "terminal.exit", leaseId: this.leaseId, exitCode, reason });
    }
    this.owner = null;
    this.pendingOwner = null;
    this.attachToken = null;
  }

  /**
   * 请求结束 PTY；最终 lease 释放仍由真实 exit 事件驱动。
   * @returns kill 完成 Promise。
   */
  async stop(): Promise<void> {
    this.clearReconnectTimer();
    if (this.ended || this.closed || this.stopping) return;
    this.stopping = true;
    await this.pty.kill();
  }

  /**
   * 服务整体关闭时结束后端会话并清除内存秘密与计时器。
   * @returns 清理完成 Promise。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    this.owner = null;
    this.pendingOwner = null;
    this.attachToken = null;
    this.buffer.clear();
  }

  /** @param ws 请求连接 @throws ATTACH_REQUIRED 未绑定或已断开 */
  private assertAttached(ws: WebSocket): void {
    if (this.closed || this.ended || this.stopping || this.owner !== ws || ws.readyState !== WebSocketState.OPEN) {
      throw new Error("ATTACH_REQUIRED");
    }
  }

  /** 取消旧重连计时器，防止重连后迟到 kill 新会话。 */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

/** 使用统一 PtyBackend 启动带 Session Hooks 的真实内嵌终端。 */
export class EmbeddedTerminalAdapter {
  private readonly probeVersion: (cliPath: string) => Promise<string>;
  private readonly childCommand: TerminalChildCommand;
  private readonly readIdentity: (pid: number) => Promise<ProcessIdentity | null>;
  private readonly reconnectMs?: number;
  private readonly bufferLimits?: TerminalOutputBufferLimits;

  /** @param deps 已由真实探针选择的 PTY 后端及可注入 Hook 边界。 */
  constructor(private readonly deps: EmbeddedTerminalDeps) {
    this.probeVersion = deps.probeVersion ?? probeCliVersion;
    this.childCommand = deps.childCommand ?? terminalChildCommand();
    this.readIdentity = deps.readIdentity ?? readProcessIdentity;
    this.reconnectMs = deps.reconnectMs;
    this.bufferLimits = deps.bufferLimits;
  }

  /**
   * 启动 claude --resume/--session-id，并连接输出缓冲、真实退出和停止操作。
   * @param context 当前 lease 的私有启动参数。
   * @returns PTY 后端句柄及连接会话。
   * @throws 原生后端或 Hook 设置启动失败。
   */
  async start(context: TerminalStartContext): Promise<EmbeddedTerminalHandle> {
    const transport = selectHookTransport(await this.probeVersion(context.cliPath));
    const helperCommand = transport === "command"
      ? terminalHookCommand(context.leaseId, this.childCommand)
      : undefined;
    const settingsFile = writeTerminalSettings(context, transport, helperCommand);
    const args = [
      ...(context.initialSessionId
        ? ["--resume", context.initialSessionId]
        : ["--session-id", context.resumeSessionId]),
      "--settings", settingsFile,
    ];
    const env = transport === "command" ? {
      ...process.env,
      CCC_TERMINAL_HOOK_URL: `http://127.0.0.1:${context.port}/terminal-hook/${context.leaseId}`,
      CCC_TERMINAL_HOOK_TOKEN: context.hookToken,
    } : process.env;
    const pty = await this.deps.backend.spawn({
      file: context.cliPath, args, cwd: context.folder, cols: 120, rows: 32, env,
    });
    const identity = await this.readIdentity(pty.pid);
    const session = new EmbeddedSession(context.leaseId, pty, () => {
      void handle.stop();
    }, {
      ...(this.reconnectMs !== undefined ? { reconnectMs: this.reconnectMs } : {}),
      ...(this.bufferLimits ? { bufferLimits: this.bufferLimits } : {}),
    });
    const exitCallbacks = new Set<(exitCode: number | null, reason?: string) => void | Promise<void>>();
    let exitResult: { exitCode: number | null; reason: string } | null = null;
    let notifyExited!: () => void;
    const exited = new Promise<void>((resolve) => { notifyExited = resolve; });
    let exitCleanup = Promise.resolve();
    /** 记录每个退出清理 Promise，让正常关闭等待最终镜像、SDK 恢复和 lease 持久化清理。 */
    const dispatchExit = (callback: (exitCode: number | null, reason?: string) => void | Promise<void>): void => {
      if (!exitResult) return;
      const cleanup = Promise.resolve().then(() => callback(exitResult!.exitCode, exitResult!.reason));
      exitCleanup = Promise.all([exitCleanup, cleanup]).then(() => undefined);
    };
    let handle: EmbeddedTerminalHandle;
    handle = {
      pid: pty.pid,
      backend: "pty",
      ...(identity ? { identity } : {}),
      session,
      onExit: (callback): void => {
        exitCallbacks.add(callback);
        if (exitResult) dispatchExit(callback); // start 返回前退出也不能丢给 lease
      },
      stop: async (): Promise<void> => { await session.stop(); },
      close: async (): Promise<void> => {
        await session.close();
        await exited; // kill 只发请求；node-helper 必须存活到真实 exit 帧到达。
        await exitCleanup;
        await this.deps.backend.close();
      },
    };
    pty.onData((data) => session.append(data));
    pty.onExit(({ exitCode }) => {
      if (exitResult) return;
      exitResult = { exitCode, reason: "exit" };
      fs.mkdirSync(context.privateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(context.privateDir, `${context.leaseId}.exit.json`), JSON.stringify({
        leaseId: context.leaseId, exitCode, reason: "exit",
      }), { encoding: "utf8", mode: 0o600 });
      session.exit(exitCode, "exit");
      for (const callback of exitCallbacks) dispatchExit(callback);
      notifyExited();
    });
    return handle;
  }

  /**
   * 在 TerminalService 已完成三项身份核对后，定向请求结束异常重启遗留的 PTY。
   * @param record 已确认仍属于同一进程的 embedded 私有 lease
   * @returns 系统结束请求已发出的 Promise
   * @throws 记录不完整或操作系统拒绝结束时抛出，调用方不得据此恢复可写状态
   */
  async recover(record: TerminalLeaseRecord): Promise<void> {
    if (record.mode !== "embedded" || !record.identity || record.identity.pid !== record.pid) {
      throw new Error("TERMINAL_RECOVERY_INVALID");
    }
    process.kill(record.identity.pid);
  }
}

/**
 * 按发行 manifest 选择已经真实探针通过的 PTY 路线。
 * 原生包缺失或记录非法只产生延迟失败后端，不能阻止系统终端和普通聊天启动。
 * @param executableDir 原生包所在目录
 * @returns 真实路线后端，或仅在 spawn 时抛 PTY_UNAVAILABLE 的降级后端
 */
export function createEmbeddedBackend(executableDir: string): PtyBackend {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(executableDir, "pty-manifest.json"), "utf8")) as {
      backend?: unknown;
    };
    if (manifest.backend === "bun-node-pty" || manifest.backend === "node-helper") {
      return createPtyBackend(manifest.backend, executableDir);
    }
  } catch {
    // 统一落入延迟失败；不得在这里读取仓库 node_modules 或猜测另一条路线。
  }
  return {
    kind: "bun-node-pty",
    spawn: async () => { throw new Error("PTY_UNAVAILABLE"); },
    close: async () => {},
  };
}

/**
 * 创建生产内嵌终端适配器；原生不可用不会在此构造阶段抛出。
 * @param executableDir 开发 native-dev 或编译 exe 旁目录
 * @returns 与系统终端共用 Hook/lease 的适配器
 */
export function createEmbeddedTerminalAdapter(
  executableDir: string = terminalNativeDirectory(),
): EmbeddedTerminalAdapter {
  return new EmbeddedTerminalAdapter({
    backend: createEmbeddedBackend(executableDir),
    childCommand: terminalChildCommand(),
  });
}
