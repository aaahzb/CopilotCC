import { randomBytes, randomUUID } from "node:crypto";
import type {
  TerminalBackend,
  TerminalMode,
  TerminalPublicState,
} from "./protocol";

export interface ProcessIdentity {
  pid: number;
  executable: string;
  startedAt: string;
}

export interface TerminalStartContext {
  leaseId: string;
  hookToken: string;
  mode: TerminalMode;
  folder: string;
  initialSessionId: string | null;
  resumeSessionId: string;
  cliPath: string;
  port: number;
  privateDir: string;
}

export interface TerminalRuntimeHandle {
  pid: number | null;
  backend: TerminalBackend;
  identity?: ProcessIdentity;
  onExit(callback: (exitCode: number | null, reason?: string) => void | Promise<void>): void;
  stop(): Promise<void>;
}

export type TerminalRuntimeFactory = (
  context: TerminalStartContext,
) => Promise<TerminalRuntimeHandle>;

export interface TerminalLeaseRecord extends TerminalStartContext {
  phase: Exclude<TerminalPublicState["phase"], "idle">;
  currentSessionId: string | null;
  confirmedSessionId: string | null;
  backend: TerminalBackend | null;
  pid: number | null;
  identity?: ProcessIdentity;
  createdAt: string;
  message?: string;
  canManualRelease: boolean;
}

export interface TerminalSessionEvent {
  event: "SessionStart" | "SessionEnd";
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  source?: "startup" | "resume" | "clear" | "compact" | "fork";
  reason?: "clear" | "resume" | "logout" | "prompt_input_exit" | "other";
}

export interface TerminalLeaseEvents {
  onState(state: TerminalPublicState): void;
  onSession(sessionId: string, previousSessionId: string | null): void;
  onMirror(sessionId: string | null): void | Promise<void>;
  onRestore(sessionId: string | null): void | Promise<void>;
  onError(
    code: "HOOK_DEGRADED" | "START_FAILED" | "IDENTITY_UNKNOWN",
    message: string,
  ): void;
}

export interface TerminalOpenInput {
  folder: string;
  initialSessionId: string | null;
  cliPath: string;
  port: number;
  privateDir: string;
  mode: TerminalMode;
}

const IDLE_STATE: TerminalPublicState = {
  leaseId: null,
  mode: null,
  phase: "idle",
  folder: null,
  initialSessionId: null,
  currentSessionId: null,
  backend: null,
  canManualRelease: false,
};

/** 协调单个工作区的终端写入权，只有真实进程退出才能正常释放 lease。 */
export class TerminalLeaseManager {
  private record: TerminalLeaseRecord | null = null;
  private handle: TerminalRuntimeHandle | null = null;
  private hookTimer: NodeJS.Timeout | null = null;

  constructor(private readonly events: TerminalLeaseEvents) {}

  /**
   * 建立新 lease 并启动对应运行时。
   * @param input 服务端解析出的工作区与 CLI 信息
   * @param start 系统或内嵌终端运行时工厂
   * @returns 启动后的脱敏公开状态
   * @throws 已有 lease、进程启动失败或启动过程被取代时抛出错误
   */
  async open(
    input: TerminalOpenInput,
    start: TerminalRuntimeFactory,
  ): Promise<TerminalPublicState> {
    if (this.record) throw new Error("ALREADY_ACTIVE");
    const context: TerminalStartContext = {
      ...input,
      leaseId: randomUUID(),
      hookToken: randomBytes(32).toString("base64url"),
      resumeSessionId: input.initialSessionId ?? randomUUID(),
    };
    this.record = {
      ...context,
      phase: "starting",
      currentSessionId: input.initialSessionId,
      confirmedSessionId: null,
      backend: null,
      pid: null,
      createdAt: new Date().toISOString(),
      canManualRelease: false,
    };
    this.emit();
    try {
      const handle = await start(context);
      if (this.record?.leaseId !== context.leaseId) {
        await handle.stop();
        throw new Error("START_SUPERSEDED");
      }
      this.record.pid = handle.pid;
      this.record.identity = handle.identity;
      this.record.backend = handle.backend;
      this.handle = handle;
      handle.onExit((code, reason) => this.completeExit(context.leaseId, code, reason).catch(() => {
        this.events.onError("START_FAILED", "终端退出后的会话恢复失败");
      }));
      this.hookTimer = setTimeout(() => this.degrade(context.leaseId), 10_000);
      this.hookTimer.unref();
      // starting 只广播一次；后端信息由定向 terminal.opened 返回。
      return this.publicState();
    } catch (error) {
      this.record = null;
      this.handle = null;
      await this.events.onRestore(input.initialSessionId);
      this.emit();
      throw error;
    }
  }

  /**
   * 从私有存储恢复 lease，但尚不恢复任何进程写入权。
   * @param record 已通过严格字段校验的系统终端记录
   * @throws 当前已有 lease 时抛出 ALREADY_ACTIVE
   */
  recover(record: TerminalLeaseRecord): void {
    if (this.record) throw new Error("ALREADY_ACTIVE");
    this.record = { ...record, canManualRelease: false };
    this.handle = null;
    this.emit();
  }

  /**
   * 身份匹配后接管既有包装进程的退出监控，不启动或结束任何进程。
   * @param leaseId 当前恢复中的 lease
   * @param handle 只观察既有 exit.json 的运行时句柄
   */
  attachRecovered(leaseId: string, handle: TerminalRuntimeHandle): void {
    if (this.record?.leaseId !== leaseId) return;
    this.handle = handle;
    handle.onExit((code, reason) => this.completeExit(leaseId, code, reason).catch(() => {
      this.events.onError("START_FAILED", "终端退出后的会话恢复失败");
    }));
  }

  /**
   * 进程身份无法确认时仍保持只读，只允许用户明确确认后人工解除。
   * @param leaseId 恢复中的 lease
   */
  markIdentityUnknown(leaseId: string): void {
    const record = this.record;
    if (!record || record.leaseId !== leaseId) return;
    record.phase = "degraded";
    record.canManualRelease = true;
    record.message = "无法确认原终端进程身份；确认终端已关闭后可人工解除";
    this.events.onError("IDENTITY_UNKNOWN", record.message);
    this.emit();
  }

  /**
   * 接受已通过 token 和路径归属校验的 CLI 会话事件。
   * @param leaseId 当前终端 lease
   * @param event 已解析的 SessionStart/SessionEnd 事件
   * @returns 事件是否属于仍可接收事件的 lease
   */
  confirmSession(leaseId: string, event: TerminalSessionEvent): boolean {
    const record = this.record;
    if (!record || record.leaseId !== leaseId || record.phase === "stopping") return false;
    // /clear 与 /resume 会先结束旧会话；旧 SessionEnd 不代表终端进程退出。
    if (event.event === "SessionEnd") return true;
    this.clearHookTimer();
    const previous = record.currentSessionId;
    record.currentSessionId = event.sessionId;
    record.confirmedSessionId = event.sessionId;
    record.phase = "active";
    delete record.message;
    this.emit();
    if (previous !== event.sessionId) this.events.onSession(event.sessionId, previous);
    return true;
  }

  /**
   * 启动十秒仍无有效 SessionStart 时进入可见降级，保持只读且不猜新会话。
   * @param leaseId 待降级的 lease
   */
  degrade(leaseId: string): void {
    if (!this.record || this.record.leaseId !== leaseId || this.record.phase !== "starting") return;
    this.record.phase = "degraded";
    this.record.message = "未收到会话事件；终端内切换会话时插件不能可靠跟随";
    this.events.onError("HOOK_DEGRADED", this.record.message);
    this.emit();
  }

  /**
   * 请求结束当前终端进程，在等待退出期间继续保持只读。
   * @param leaseId 请求关闭的 lease
   * @throws lease 不存在时抛出 NOT_FOUND
   */
  async requestStop(leaseId: string): Promise<void> {
    if (!this.record || this.record.leaseId !== leaseId) throw new Error("NOT_FOUND");
    if (this.record.phase === "stopping") return;
    this.clearHookTimer();
    this.record.phase = "stopping";
    this.emit();
    await this.handle?.stop();
  }

  /**
   * 处理真实运行时退出，最终镜像完成后才恢复 SDK 和插件输入。
   * @param leaseId 已退出的 lease
   * @param _exitCode 进程退出码，由服务层用于退出通知
   * @param _reason 可选退出原因，由服务层用于退出通知
   */
  async completeExit(
    leaseId: string,
    _exitCode: number | null,
    _reason?: string,
  ): Promise<void> {
    const record = this.record;
    if (!record || record.leaseId !== leaseId) return;
    this.clearHookTimer();
    if (record.phase !== "stopping") {
      record.phase = "stopping";
      this.emit();
    }
    const restore = record.confirmedSessionId ?? record.initialSessionId;
    try {
      await this.events.onMirror(restore);
      await this.events.onRestore(restore);
    } finally {
      if (this.record?.leaseId === leaseId) {
        this.record = null;
        this.handle = null;
        this.emit();
      }
    }
  }

  /**
   * 在重启后进程身份无法确认时，按用户明确确认解除只读，不杀进程。
   * @param leaseId 待人工解除的 lease
   * @throws 非人工解除状态或 lease 不匹配时抛出 CONFIRM_REQUIRED
   */
  async forceRelease(leaseId: string): Promise<void> {
    if (!this.record || this.record.leaseId !== leaseId || !this.record.canManualRelease) {
      throw new Error("CONFIRM_REQUIRED");
    }
    const restore = this.record.confirmedSessionId ?? this.record.initialSessionId;
    this.clearHookTimer();
    this.record = null;
    this.handle = null;
    await this.events.onRestore(restore);
    this.emit();
  }

  /** @returns 当前 lease 的脱敏快照；idle 时所有标识均为 null */
  publicState(): TerminalPublicState {
    const record = this.record;
    if (!record) return { ...IDLE_STATE };
    return {
      leaseId: record.leaseId,
      mode: record.mode,
      phase: record.phase,
      folder: record.folder,
      initialSessionId: record.initialSessionId,
      currentSessionId: record.currentSessionId,
      backend: record.backend,
      ...(record.message ? { message: record.message } : {}),
      canManualRelease: record.canManualRelease,
    };
  }

  /**
   * 仅供桥接内部 Hook/watcher/store 读取的私有记录，禁止直接序列化到客户端。
   * @returns 当前私有 lease；无接管时返回 null
   */
  currentRecord(): TerminalLeaseRecord | null {
    return this.record;
  }

  /** 清除启动降级计时器，避免退出或确认后迟到修改新状态。 */
  private clearHookTimer(): void {
    if (this.hookTimer) clearTimeout(this.hookTimer);
    this.hookTimer = null;
  }

  /** 向所有聊天视图广播新的脱敏状态对象，避免私有记录意外序列化。 */
  private emit(): void {
    this.events.onState(this.publicState());
  }
}
