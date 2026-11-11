import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerMessage, TerminalMode, TerminalPublicState } from "./protocol";
import type { EmbeddedSession, EmbeddedTerminalHandle } from "./embedded-terminal";
import type { ReplayPage } from "./terminal-output-buffer";
import { isValidFolder, type SessionManager } from "./session-manager";
import type { AliasManager } from "./alias-manager";
import { listSessions, transcriptProjectsRoot, type TranscriptPage } from "./transcript";
import {
  TerminalLeaseManager,
  type ProcessIdentity,
  type TerminalLeaseRecord,
  type TerminalRuntimeFactory,
  type TerminalRuntimeHandle,
  type TerminalStartContext,
} from "./terminal-lease";
import type { TerminalHookHttpDeps } from "./terminal-hooks";
import { TranscriptWatcher } from "./transcript-watcher";
import { TerminalLeaseStore } from "./terminal-store";
import { isProcessAlive, matchesProcessIdentity } from "./process-identity";
import { hasTerminalExit } from "./system-terminal";

export interface TerminalServiceDeps {
  sessions: SessionManager;
  aliases?: AliasManager;
  getWorkspace(): {
    folder: string | null;
    currentAliasId: string | null;
    busy: boolean;
    pendingCount: number;
    sessionId: string | null;
  };
  suspendSdk(): Promise<void>;
  restoreSdk(sessionId: string | null): void;
  readHistoryPage(folder: string, sessionId: string): TranscriptPage;
  broadcast(message: ServerMessage): void;
  pushSessionList(): void;
  syncCurrentAlias(): void;
  pushAliasList(): void;
  configDir: string;
  privateDir: string;
  getPort(): number;
  resolveCli(): string | undefined;
  system: TerminalRuntimeFactory;
  /** 内嵌 PTY 运行时；缺省时仅 embedded 返回 PTY_UNAVAILABLE，系统终端与聊天不受影响 */
  embedded?: (context: TerminalStartContext) => Promise<EmbeddedTerminalHandle>;
  /** 身份已完全匹配后清理遗留内嵌 PTY，不重新打开页面；绝不用于 unknown 身份 */
  recoverEmbedded?(record: TerminalLeaseRecord): Promise<void>;
  /** 接管已有系统进程的退出文件，不重新启动终端；缺省时身份匹配也只能保持 unknown */
  recover?(record: TerminalLeaseRecord): TerminalRuntimeHandle;
  /** 核对 PID、可执行路径和 OS 启动时间；测试注入避免查询无关真实进程 */
  matchesIdentity?(identity: ProcessIdentity): Promise<boolean>;
  /** 无副作用探测 PID；测试注入，生产只有 ESRCH 才认定进程已退出 */
  isProcessAlive?(pid: number): boolean;
  /** 在只读 lease 已建立后恢复绑定和 watcher，不得创建 SDK Query */
  prepareRecovery(record: TerminalLeaseRecord): void;
}

/** 共用 lease、watcher 与结构化镜像；后续系统/PTY 适配器只提供运行时。 */
export class TerminalService {
  readonly leases: TerminalLeaseManager;
  private readonly watcher: TranscriptWatcher;
  private readonly store: TerminalLeaseStore;
  private readonly embeddedStore: TerminalLeaseStore;
  private readonly mirrorRevisions = new Map<string, number>();
  private lastSystemLeaseId: string | null = null;
  private lastEmbeddedLeaseId: string | null = null;
  private embeddedHandle: EmbeddedTerminalHandle | null = null;

  constructor(private readonly deps: TerminalServiceDeps) {
    this.store = new TerminalLeaseStore(path.join(deps.privateDir, "system-lease.json"));
    this.embeddedStore = new TerminalLeaseStore(path.join(deps.privateDir, "embedded-lease.json"));
    this.leases = new TerminalLeaseManager({
      onState: (state) => {
        this.persistState(state);
        this.deps.broadcast({ type: "terminal.state", state });
        if (state.phase === "idle" && this.embeddedHandle) {
          const finished = this.embeddedHandle;
          this.embeddedHandle = null;
          void finished.close();
        }
      },
      onSession: (sessionId, previousSessionId) => {
        const lease = this.leases.currentRecord();
        if (!lease) return;
        const existing = this.deps.sessions.get(lease.folder);
        const discovered = listSessions(lease.folder).find((item) => item.sessionId === sessionId);
        this.deps.sessions.set(lease.folder, {
          sessionId,
          title: discovered?.title ?? (existing?.sessionId === sessionId ? existing.title : "(新会话)"),
          updatedAt: new Date().toISOString(),
        });
        // Hook 是切会话的唯一权威来源；这里只更新映射，绝不重建一个 SDK Query 双写。
        this.deps.syncCurrentAlias();
        this.deps.pushAliasList();
        this.deps.pushSessionList();
        this.deps.broadcast({
          type: "folder.bound",
          reset: previousSessionId !== sessionId,
          path: lease.folder,
          resumed: true,
          title: discovered?.title ?? existing?.title ?? "",
          sessionId,
        });
        this.pushMirror(sessionId);
      },
      onMirror: (sessionId) => {
        if (sessionId) this.pushMirror(sessionId);
      },
      onRestore: (sessionId) => this.deps.restoreSdk(sessionId),
      onError: (code, message) => this.deps.broadcast({
        type: "terminal.error",
        code,
        message,
        ...(this.leases.publicState().leaseId
          ? { leaseId: this.leases.publicState().leaseId! }
          : {}),
      }),
    });
    this.watcher = new TranscriptWatcher({
      onList: () => this.deps.pushSessionList(), // 普通外部终端也只发现列表，绝不接管镜像
      onTranscript: (sessionId) => {
        const lease = this.leases.currentRecord();
        if (lease?.currentSessionId === sessionId) this.pushMirror(sessionId);
      },
    });
  }

  /** @returns 当前脱敏状态；没有接管时为 idle */
  publicState(): TerminalPublicState {
    return this.leases.publicState();
  }

  /** @returns 是否存在仍需禁止插件写入的 lease，包括降级和停止中 */
  isActive(): boolean {
    return this.leases.currentRecord() !== null;
  }

  /** @returns HTTP Hook 与当前私有 lease 的窄连接，不暴露 token 给 WS 客户端 */
  hookDeps(): TerminalHookHttpDeps {
    return {
      currentRecord: () => this.leases.currentRecord(),
      confirmSession: (leaseId, event) => this.leases.confirmSession(leaseId, event),
      projectsRoot: transcriptProjectsRoot(),
    };
  }

  /**
   * 校验唯一工作区后接管系统终端。
   * @param mode 必须为 system；embedded 使用 openEmbedded 以保留页面连接。
   * @returns 含 leaseId 和实际 backend 的脱敏状态。
   * @throws NO_FOLDER/WORKSPACE_BUSY/CLI_NOT_FOUND/ALREADY_ACTIVE/START_FAILED。
   */
  async open(mode: TerminalMode): Promise<TerminalPublicState> {
    if (mode !== "system") throw new Error("START_FAILED");
    return this.openRuntime(mode, this.deps.system);
  }

  /**
   * 启动内嵌 PTY 并保留请求连接的初次 attach 权。
   * @param ws 发起 terminal.open 的已认证连接。
   * @returns 脱敏状态和只定向返回该连接的 attachToken。
   * @throws PTY_UNAVAILABLE 未注入原生后端；其余错误与系统终端一致。
   */
  async openEmbedded(ws: WebSocket): Promise<{ state: TerminalPublicState; attachToken: string }> {
    if (!this.deps.embedded) throw new Error("PTY_UNAVAILABLE");
    const handles: EmbeddedTerminalHandle[] = [];
    const state = await this.openRuntime("embedded", async (context) => {
      const handle = await this.deps.embedded!(context);
      handles.push(handle);
      return handle;
    });
    const handle = handles[0];
    if (!handle || !state.leaseId) throw new Error("START_FAILED");
    this.embeddedHandle = handle;
    handle.session.reserve(ws);
    return { state, attachToken: handle.session.issueAttachToken() };
  }

  /**
   * 绑定终端页面并返回统一缓冲中的重放页。
   * @param ws 请求 attach 的连接。
   * @param leaseId 当前 embedded lease。
   * @param attachToken 定向 opened 返回的内存凭据。
   * @param afterSeq 页面最后连续序号。
   * @returns 重放页；调用方在 gap=true 时必须停止。
   */
  attach(ws: WebSocket, leaseId: string, attachToken: string, afterSeq: number): ReplayPage {
    return this.embeddedSession(leaseId).attach(ws, attachToken, afterSeq);
  }

  /** @param ws 请求连接 @param leaseId 当前 lease @param data 键盘输入 */
  write(ws: WebSocket, leaseId: string, data: string): void {
    this.embeddedSession(leaseId).write(ws, data);
  }

  /** @param ws 请求连接 @param leaseId 当前 lease @param cols 列数 @param rows 行数 */
  resize(ws: WebSocket, leaseId: string, cols: number, rows: number): void {
    this.embeddedSession(leaseId).resize(ws, cols, rows);
  }

  /** @param ws 断开的连接；普通聊天连接不影响 PTY */
  disconnect(ws: WebSocket): void {
    this.embeddedHandle?.session.detach(ws);
  }

  /** @returns 关闭当前 embedded 后端和所有重连计时器的 Promise */
  async closeEmbedded(): Promise<void> {
    const handle = this.embeddedHandle;
    this.embeddedHandle = null;
    await handle?.close();
  }

  /** @param leaseId 当前 embedded lease @returns 对应会话，否则抛出固定错误 */
  private embeddedSession(leaseId: string): EmbeddedSession {
    const record = this.leases.currentRecord();
    const handle = this.embeddedHandle;
    if (record?.mode !== "embedded" || record.leaseId !== leaseId || !handle) throw new Error("NOT_FOUND");
    return handle.session;
  }

  /**
   * 两种终端共用的唯一 lease 启动路径。
   * @param mode system 或 embedded。
   * @param start 对应运行时工厂。
   * @returns 启动后的公开状态。
   */
  private async openRuntime(mode: TerminalMode, start: TerminalRuntimeFactory): Promise<TerminalPublicState> {
    if (this.leases.currentRecord()) throw new Error("ALREADY_ACTIVE");
    const workspace = this.deps.getWorkspace();
    const alias = this.deps.aliases && workspace.currentAliasId
      ? this.deps.aliases.get(workspace.currentAliasId)
      : undefined;
    const folder = alias?.folder ?? workspace.folder;
    if (!folder || !isValidFolder(folder)) throw new Error("NO_FOLDER");
    if (workspace.busy || workspace.pendingCount > 0) throw new Error("WORKSPACE_BUSY");
    const cliPath = this.deps.resolveCli();
    if (!cliPath) throw new Error("CLI_NOT_FOUND");
    const initialSessionId = alias?.sessionId ?? this.deps.sessions.get(folder)?.sessionId ?? null;
    const state = await this.leases.open({
      folder,
      initialSessionId,
      cliPath,
      port: this.deps.getPort(),
      privateDir: this.deps.privateDir,
      mode,
    }, async (context) => {
      await this.deps.suspendSdk();
      return start(context);
    });
    this.persistState(state); // 后端身份在 starting 首帧后才到位，私有记录必须补存而不能重复广播
    return state;
  }

  /**
   * 启动时恢复一种私有终端 lease；身份不明也保持只读，绝不重开终端或猜杀 PID。
   * @returns 完成身份核对、退出清理或 unknown 屏障后的 Promise
   * @throws 私有记录读取、恢复绑定或已确认进程清理失败时向上抛出
   */
  async recover(): Promise<void> {
    const systemRecord = this.store.load();
    const embeddedRecord = this.embeddedStore.load();
    const record = systemRecord?.mode === "system"
      ? systemRecord
      : embeddedRecord?.mode === "embedded" ? embeddedRecord : null;
    if (!record) return;
    this.leases.recover(record); // 先建立只读屏障，prepareRecovery 内的 bindFolder 才不会创建 SDK Query
    this.deps.prepareRecovery(record);
    const exited = hasTerminalExit(record);
    // Windows 强杀 ConPTY owner 后客户端可能已随 master 退出且来不及写 exit 文件。
    // 只有 ESRCH 能走此分支；权限/查询错误仍按存活未知处理，不得跳过身份核对。
    const processExited = !exited && record.mode === "embedded" && record.pid !== null
      && !(this.deps.isProcessAlive ?? isProcessAlive)(record.pid);
    const identityMatches = !exited && !processExited && record.identity
      ? await (this.deps.matchesIdentity
        ? this.deps.matchesIdentity(record.identity)
        : matchesProcessIdentity(record.identity))
      : false;
    if (this.leases.publicState().leaseId !== record.leaseId) return;
    if (record.mode === "embedded") {
      if (exited || processExited) {
        await this.leases.completeExit(record.leaseId, 0, "exit");
      } else if (identityMatches && this.deps.recoverEmbedded) {
        await this.deps.recoverEmbedded(record); // 只有 PID、路径和启动时间三项匹配后才允许结束旧 PTY
        await this.leases.completeExit(record.leaseId, 0, "recovered");
      } else {
        this.leases.markIdentityUnknown(record.leaseId);
      }
      return;
    }
    if (exited || identityMatches) {
      const handle = record.identity && record.backend ? this.deps.recover?.(record) : undefined;
      if (handle) this.leases.attachRecovered(record.leaseId, handle);
      else if (exited) await this.leases.completeExit(record.leaseId, 0, "exit");
      else this.leases.markIdentityUnknown(record.leaseId); // 没有可接管的句柄时不能宣称已确认存活
      return;
    }
    this.leases.markIdentityUnknown(record.leaseId);
  }

  /** @param state 当前脱敏状态；系统与内嵌终端分别写入自己的私有恢复文件 */
  private persistState(state: TerminalPublicState): void {
    try {
      if (state.phase === "idle") {
        if (this.lastSystemLeaseId) this.store.clear(this.lastSystemLeaseId);
        if (this.lastEmbeddedLeaseId) this.embeddedStore.clear(this.lastEmbeddedLeaseId);
        this.lastSystemLeaseId = null;
        this.lastEmbeddedLeaseId = null;
        return;
      }
      if ((state.mode !== "system" && state.mode !== "embedded") || !state.leaseId) return;
      const record = this.leases.currentRecord();
      if (!record || record.leaseId !== state.leaseId) return;
      if (state.mode === "system") {
        this.lastSystemLeaseId = state.leaseId;
        this.store.save(record);
      } else {
        this.lastEmbeddedLeaseId = state.leaseId;
        this.embeddedStore.save(record);
      }
    } catch {
      // 持久化失败不能撤销只读屏障；向视图明示重启恢复可能不可用，且不输出私有路径或 token。
      this.deps.broadcast({
        type: "terminal.error",
        code: "START_FAILED",
        message: "终端接管记录保存失败；桥接重启后可能需要人工核对",
        ...(state.leaseId ? { leaseId: state.leaseId } : {}),
      });
    }
  }

  /** 无参数时关闭 watcher；传 leaseId 时只请求对应终端停止。 */
  close(): void;
  close(leaseId: string): Promise<void>;
  close(leaseId?: string): void | Promise<void> {
    if (leaseId === undefined) {
      this.watcher.close();
      return;
    }
    return this.leases.requestStop(leaseId);
  }

  /** @param leaseId 身份无法确认且用户明确确认关闭的 lease @returns 恢复 SDK 后的 Promise */
  async release(leaseId: string): Promise<void> {
    await this.leases.forceRelease(leaseId);
  }

  /** @param folder 当前绑定工作目录；替换旧目录时关闭旧 watcher */
  bindFolder(folder: string): void {
    this.watcher.bind(folder);
  }

  /** 推送当前会话列表；不根据 mtime 改当前 sessionId。 */
  pushSessionList(): void {
    this.deps.pushSessionList();
  }

  /**
   * 读取并广播 lease 当前会话的最新结构化页面。
   * @param sessionId watcher 或 Hook 指定的会话
   */
  pushMirror(sessionId: string): void {
    const lease = this.leases.currentRecord();
    if (!lease || lease.currentSessionId !== sessionId) return;
    const page = this.deps.readHistoryPage(lease.folder, sessionId);
    const revision = (this.mirrorRevisions.get(sessionId) ?? 0) + 1;
    this.mirrorRevisions.set(sessionId, revision);
    this.deps.broadcast({
      type: "session.mirror.data",
      sessionId,
      revision,
      messages: page.messages,
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }
}
