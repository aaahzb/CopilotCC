import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  validatePtySpawnOptions,
  type PtyBackend,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnOptions,
} from "./pty-backend";

const MAX_FRAME_BYTES = 1_048_576;
const START_TIMEOUT_MS = 10_000;

/** NodePtyBackend 的可注入依赖。 */
export interface NodePtyBackendOptions {
  nodePath: string;
  helperPath: string;
  spawn?: typeof spawnChild;
}

interface PendingStart {
  resolve: (proc: PtyProcess) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 主进程中的 helper 进程代理，所有事件按请求 id 隔离。 */
class HelperPtyProcess implements PtyProcess {
  private dataCallback: ((data: string) => void) | undefined;
  private earlyData: string[] = [];
  private exitCallback: ((event: PtyExitEvent) => void) | undefined;
  private exitEvent: PtyExitEvent | undefined;
  private killed = false;
  private exited = false;

  /** @param owner 所属后端。 @param id 唯一请求 id。 @param pid helper 返回的真实 PID。 */
  constructor(private readonly owner: NodePtyBackend, readonly id: number, readonly pid: number) {}

  /** @param callback 输出回调；先补发订阅前到达的块。 @returns 无。 */
  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
    for (const data of this.earlyData.splice(0)) callback(data);
  }

  /** @param callback 退出回调。 @returns 无。 */
  onExit(callback: (event: PtyExitEvent) => void): void {
    this.exitCallback = callback;
    if (this.exitEvent) queueMicrotask(() => callback(this.exitEvent!));
  }

  /** @param data 终端输入。 @returns 无。 */
  write(data: string): void {
    if (!this.killed && !this.exited) this.owner.send({ type: "write", id: this.id, data });
  }

  /** @param cols 列数。 @param rows 行数。 @returns 无。 */
  resize(cols: number, rows: number): void {
    if (!this.killed && !this.exited) this.owner.send({ type: "resize", id: this.id, cols, rows });
  }

  /** @returns 首次发送 kill，重复调用不再发送。 */
  async kill(): Promise<void> {
    if (this.killed || this.exited) return;
    this.killed = true;
    this.earlyData = [];
    this.owner.send({ type: "kill", id: this.id });
  }

  /** @param data 一帧原始输出。 @returns 无。 */
  receiveData(data: string): void {
    if (this.killed || this.exited) return;
    if (this.dataCallback) this.dataCallback(data);
    else this.earlyData.push(data);
  }

  /** @param event 原生或 helper 异常退出事件。 @returns 无。 */
  receiveExit(event: PtyExitEvent): void {
    if (this.exited) return;
    this.exited = true;
    this.exitEvent = event;
    this.exitCallback?.(event);
    this.owner.forget(this.id);
  }

  /** @returns 是否已发起 kill。 */
  isKilled(): boolean { return this.killed; }
}

/** 通过随发行包携带的 Node 22 helper 使用 node-pty。 */
export class NodePtyBackend implements PtyBackend {
  readonly kind = "node-helper" as const;
  private readonly spawnProcess: typeof spawnChild;
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingStart>();
  private readonly processes = new Map<number, HelperPtyProcess>();
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private closedFlag = false;
  private stderrTail = "";

  /** @param options helper 路径、Node 路径与可选进程工厂。 */
  constructor(private readonly options: NodePtyBackendOptions) {
    this.spawnProcess = options.spawn ?? spawnChild;
  }

  /**
   * 请求 helper 启动 PTY。
   * @param options 启动参数。
   * @returns started 帧到达后的进程代理。
   * @throws {Error} 参数非法、helper 启动失败、超时或后端已关闭。
   */
  async spawn(options: PtySpawnOptions): Promise<PtyProcess> {
    validatePtySpawnOptions(options);
    if (this.closedFlag) throw new Error("PTY_BACKEND_CLOSED");
    const id = this.nextId++;
    return new Promise<PtyProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.send({ type: "kill", id }); } catch { /* helper 已退出时无需补发。 */ }
        reject(new Error("HELPER_START_TIMEOUT"));
      }, START_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ensureChild();
        this.send({ type: "start", id, options });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** @returns helper 是否已退出或被关闭。 */
  closed(): boolean { return this.closedFlag; }

  /**
   * 向 helper 写入单条 JSONL 请求。
   * @param frame 不含秘密日志的请求对象。
   * @returns 无。
   * @throws {Error} helper 管道不可用。
   */
  send(frame: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (this.closedFlag || !stdin || !stdin.writable) throw new Error("PTY_BACKEND_CLOSED");
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** @param id 已结束请求 id。 @returns 无。 */
  forget(id: number): void { this.processes.delete(id); }

  /** @returns 关闭 helper 及其拥有的 PTY，可重复调用。 */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    for (const proc of [...this.processes.values()]) {
      try { await proc.kill(); } catch { /* 随后直接结束 helper。 */ }
    }
    this.closedFlag = true;
    this.rejectPending(new Error("PTY_BACKEND_CLOSED"));
    this.child?.kill();
  }

  /** @returns 无；首次调用时建立本地管道。 */
  private ensureChild(): void {
    if (this.child) return;
    this.child = this.spawnProcess(this.options.nodePath, [this.options.helperPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.acceptOutput(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      // stderr 只保留诊断尾部，不记录请求、环境或终端正文。
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    this.child.on("error", () => this.fail(new Error("HELPER_PROCESS_ERROR")));
    this.child.on("exit", () => this.fail(new Error("HELPER_PROCESS_EXIT")));
    this.child.stdin?.on("error", () => this.fail(new Error("HELPER_STDIN_ERROR")));
  }

  /** @param chunk helper stdout 的 UTF-8 字节。 @returns 无。 */
  private acceptOutput(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_FRAME_BYTES && !this.stdoutBuffer.includes("\n")) {
      this.fail(new Error("HELPER_FRAME_TOO_LARGE"));
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        this.fail(new Error("HELPER_FRAME_TOO_LARGE"));
        return;
      }
      if (line) this.acceptFrame(line);
      if (this.closedFlag) return;
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  /** @param line 一条 JSON 响应。 @returns 无。 */
  private acceptFrame(line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") throw new Error("shape");
      frame = parsed as Record<string, unknown>;
    } catch {
      this.fail(new Error("HELPER_INVALID_FRAME"));
      return;
    }
    const id = typeof frame.id === "number" ? frame.id : null;
    if (frame.type === "started" && id !== null && typeof frame.pid === "number") {
      const pending = this.pending.get(id);
      if (!pending) {
        try { this.send({ type: "kill", id }); } catch { /* 后端可能正在关闭。 */ }
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const proc = new HelperPtyProcess(this, id, frame.pid);
      this.processes.set(id, proc);
      pending.resolve(proc);
      return;
    }
    if (frame.type === "data" && id !== null && typeof frame.data === "string") {
      this.processes.get(id)?.receiveData(frame.data);
      return;
    }
    if (frame.type === "exit" && id !== null && typeof frame.exitCode === "number") {
      this.processes.get(id)?.receiveExit({
        exitCode: frame.exitCode,
        signal: typeof frame.signal === "number" ? frame.signal : null,
      });
      return;
    }
    if (frame.type === "error" && typeof frame.code === "string") {
      const message = typeof frame.message === "string" ? frame.message.slice(0, 500) : "helper error";
      const error = new Error(`${frame.code}: ${message}`);
      if (id !== null && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      } else if (id !== null) {
        this.processes.get(id)?.receiveExit({ exitCode: 1, signal: null });
      }
      return;
    }
    this.fail(new Error("HELPER_INVALID_FRAME"));
  }

  /** @param error 仅用于本地拒绝与关闭的原因。 @returns 无。 */
  private fail(error: Error): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.rejectPending(error);
    for (const proc of [...this.processes.values()]) proc.receiveExit({ exitCode: 1, signal: null });
    this.child?.kill();
  }

  /** @param error 拒绝所有尚未 started 的请求。 @returns 无。 */
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
