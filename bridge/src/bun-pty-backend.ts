import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { IPty } from "node-pty";
import { isProcessAlive } from "./process-identity";
import { diagLog } from "./startup-diagnostics";
import {
  validatePtySpawnOptions,
  type NodePtyModule,
  type PtyBackend,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnOptions,
} from "./pty-backend";

/** node-pty 内部原生加载器的窄接口。 */
interface NodePtyNativeUtils {
  loadNativeModule(name: string): { dir: string; module: unknown };
}

/** 与 process.dlopen 兼容的可注入原生加载函数。 */
type NativeDlopen = (module: { exports: unknown }, filename: string) => void;

/** BunPtyBackend 的可注入依赖。 */
export interface BunPtyBackendOptions {
  executableDir: string;
  require?: (id: string) => unknown;
  dlopen?: NativeDlopen;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Windows 关闭前强制结束 PTY 客户端进程树；默认 taskkill，测试可注入 */
  killTree?: (pid: number) => Promise<void>;
  /** Windows 关闭时先等待 CLI 自行退出的宽限期（毫秒）；默认 1000，测试可缩短 */
  closeGraceMs?: number;
  /** 关闭时两次 Ctrl+C 的间隔（毫秒）；必须小于 CLI 的 0.8 秒确认窗口 */
  closeInterruptGapMs?: number;
  /** 宽限期内判断 PID 是否存活；默认 signal 0 探测，测试可注入 */
  isAlive?: (pid: number) => boolean;
}

/** 实测 Claude Code 在第二次 Ctrl+C 后约 0.56 秒退出；取整 1 秒，兼顾满载机器余量。 */
const DEFAULT_CLOSE_GRACE_MS = 1000;

/** 两次 Ctrl+C 的间隔。CLI 只在约 0.8 秒内连按两次才确认退出；实测 0.12 秒稳定。 */
const DEFAULT_INTERRUPT_GAP_MS = 120;

/** 宽限期内检查进程是否已退出的轮询间隔。 */
const CLOSE_POLL_INTERVAL_MS = 100;

/** Windows 优雅关闭配置：先请 CLI 自己退出，宽限期满才强杀。 */
interface GracefulCloseOptions {
  killTree: (pid: number) => Promise<void>;
  graceMs: number;
  interruptGapMs: number;
  isAlive: (pid: number) => boolean;
}

/**
 * 等待指定毫秒数。
 * @param ms 等待时长（毫秒）
 * @returns 定时结束后的 Promise
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows 下强制结束 PTY 客户端进程树。
 * ClosePseudoConsole 会同步等待控制台客户端响应关闭事件；客户端来不及退出时
 * 系统会等满约 5 秒宽限期才强杀，这段时间会冻结调用线程。提前 taskkill 可消除等待。
 * @param pid PTY 客户端进程 PID（已由 lease 身份核对）
 * @returns taskkill 退出、失败或 3 秒超时后完成；始终 resolve，不阻塞关闭流程
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        // taskkill 自身卡住时立即回退；后面的原生关闭仍会结束终端。
        try {
          child.kill();
        } catch {
          // 已经退出时忽略。
        }
        done();
      }, 3000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      child.once("error", () => {
        clearTimeout(timer);
        done();
      });
    } catch {
      // spawn 同步失败（例如 taskkill 不存在）时回退到原生关闭。
      done();
    }
  });
}

/**
 * 转换为 Windows 原生 API 可识别的扩展绝对路径。
 * @param file 原生模块路径
 * @returns 带 \\?\ 或 \\?\UNC\ 前缀的路径；已有扩展前缀时保持不变
 */
function extendedWindowsPath(file: string): string {
  const resolved = path.win32.resolve(file);
  if (resolved.startsWith("\\\\?\\")) return resolved;
  if (resolved.startsWith("\\\\")) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

/** 将 node-pty 事件适配为幂等、可迟到订阅的统一进程。 */
class BunPtyProcess implements PtyProcess {
  readonly pid: number;
  private dataCallback: ((data: string) => void) | undefined;
  private earlyData: string[] = [];
  private exitCallback: ((event: PtyExitEvent) => void) | undefined;
  private exitEvent: PtyExitEvent | undefined;
  private killed = false;
  private exited = false;

  /**
   * 包装一个真实 node-pty 进程。
   * @param raw 原生进程。
   * @param onExit 用于后端移除已退出进程。
   * @param graceful Windows 优雅关闭配置；其它平台为 undefined。
   */
  constructor(
    private readonly raw: IPty,
    onExit: () => void,
    private readonly graceful?: GracefulCloseOptions,
  ) {
    this.pid = raw.pid;
    raw.onData((data) => {
      // kill 后的迟到输出只属于旧进程，不能进入后续屏幕。
      if (this.killed || this.exited) return;
      if (this.dataCallback) this.dataCallback(data);
      else this.earlyData.push(data);
    });
    raw.onExit(({ exitCode, signal }) => {
      if (this.exited) return;
      this.exited = true;
      // Windows ConPTY 被 taskkill 强杀后运行时可能不给退出码（类型声明与真实行为不符），
      // 统一归一为 null，协议与界面都按“无退出码”处理，不能漏出 undefined。
      this.exitEvent = { exitCode: typeof exitCode === "number" ? exitCode : null, signal: signal ?? null };
      this.exitCallback?.(this.exitEvent);
      onExit();
    });
  }

  /** @param callback 输出回调；先补发订阅前到达的块。 @returns 无。 */
  onData(callback: (data: string) => void): void {
    this.dataCallback = callback;
    for (const data of this.earlyData.splice(0)) callback(data);
  }

  /** @param callback 退出回调；已退出时异步补发。 @returns 无。 */
  onExit(callback: (event: PtyExitEvent) => void): void {
    this.exitCallback = callback;
    if (this.exitEvent) queueMicrotask(() => callback(this.exitEvent!));
  }

  /** @param data 要写入 PTY 的字符串。 @returns 无。 */
  write(data: string): void {
    if (!this.killed && !this.exited) this.raw.write(data);
  }

  /** @param cols 列数。 @param rows 行数。 @returns 无。 */
  resize(cols: number, rows: number): void {
    if (!this.killed && !this.exited) this.raw.resize(cols, rows);
  }

  private diagCloseWrapped = false;

  /**
   * 临时诊断：包装 node-pty 内部 kill 阶段，定位关闭终端时约 5s 的同步阻塞。
   * 只在第一次 kill 前执行；任何内部结构缺失都静默跳过。
   */
  private diagnoseKill(): void {
    try {
      const raw = this.raw as unknown as {
        _agent?: {
          __cccDiag?: boolean;
          _getConsoleProcessList?: () => Promise<number[]>;
          _ptyNative?: { kill?: (...args: unknown[]) => void };
          _conoutSocketWorker?: { dispose?: () => void };
        };
        _isReady?: boolean;
        _close?: () => void;
      };
      diagLog(`pty.diag ready=${Number(raw._isReady)} agent=${Number(Boolean(raw._agent))}`);
      // WindowsTerminal.kill 先同步调用实例 _close 销毁 conout 套接字，单独计时。
      if (!this.diagCloseWrapped && typeof raw._close === "function") {
        this.diagCloseWrapped = true;
        const rawClose = raw._close;
        raw._close = function diagClose(this: unknown): void {
          const startedAt = Date.now();
          rawClose.call(this);
          diagLog(`pty.close ${Date.now() - startedAt}ms`);
        };
      }
      const agent = raw._agent;
      if (!agent || agent.__cccDiag) return;
      agent.__cccDiag = true;
      const list = agent._getConsoleProcessList;
      if (list) {
        agent._getConsoleProcessList = function diagList(): Promise<number[]> {
          const startedAt = Date.now();
          diagLog("pty.consoleList call");
          const pending = list.call(agent);
          void pending.then(
            (pids) => diagLog(`pty.consoleList ${Date.now() - startedAt}ms pids=${pids.length}`),
            (error: unknown) => diagLog(
              `pty.consoleList.reject ${Date.now() - startedAt}ms ${error instanceof Error ? error.message : ""}`,
            ),
          );
          return pending;
        };
      }
      const native = agent._ptyNative;
      if (native?.kill) {
        const killNative = native.kill;
        native.kill = function diagNativeKill(this: typeof native, ...args: unknown[]): void {
          const startedAt = Date.now();
          killNative.apply(this, args);
          diagLog(`pty.nativeKill ${Date.now() - startedAt}ms`);
        };
      }
      const worker = agent._conoutSocketWorker;
      if (worker?.dispose) {
        const dispose = worker.dispose;
        worker.dispose = function diagDispose(this: typeof worker): void {
          const startedAt = Date.now();
          dispose.call(this);
          diagLog(`pty.conoutDispose ${Date.now() - startedAt}ms`);
        };
      }
    } catch {
      // 诊断包装失败不影响真实 kill。
    }
  }

  /**
   * 临时诊断：包装 child_process.fork，测量 console-list agent 的派生耗时与子进程存活期。
   * 仅用于判断 5s 阻塞是否发生在 fork 调用本身。
   */
  private diagnoseFork(): void {
    try {
      const cp = createRequire(import.meta.url)("child_process") as {
        fork?: (...args: unknown[]) => unknown;
        __cccForkDiag?: boolean;
      };
      if (typeof cp.fork !== "function" || cp.__cccForkDiag) return;
      cp.__cccForkDiag = true;
      const original = cp.fork;
      cp.fork = function diagFork(this: unknown, ...args: unknown[]): unknown {
        const startedAt = Date.now();
        const child = original.apply(cp, args) as {
          pid?: number;
          on?: (event: string, listener: (...values: unknown[]) => void) => void;
        } | undefined;
        diagLog(`pty.fork call ${Date.now() - startedAt}ms pid=${child?.pid ?? -1}`);
        try {
          child?.on?.("exit", (code: unknown, signal: unknown) => {
            diagLog(`pty.fork child exit code=${String(code)} signal=${String(signal)} after=${Date.now() - startedAt}ms`);
          });
          child?.on?.("error", (error: unknown) => {
            diagLog(`pty.fork child error ${error instanceof Error ? error.message : String(error)}`);
          });
        } catch {
          // 子进程事件包装失败不影响真实 fork。
        }
        return child;
      };
    } catch {
      // 诊断包装失败不影响真实 kill。
    }
  }

  /**
   * 请求 CLI 通过两次 Ctrl+C 自行退出，并在宽限期内等待其真正结束。
   * 直接 taskkill 会跳过 CLI 的退出钩子，留下全屏启动标记，下次启动提示“上次没有正确关闭”。
   * @param options 宽限期、按键间隔与存活探测
   * @returns 宽限期内退出（或探测到已不存在）为 true；仍需强杀为 false
   */
  private async interruptAndWait(options: GracefulCloseOptions): Promise<boolean> {
    const startedAt = Date.now();
    // 两次 Ctrl+C 是 Claude Code 的正常退出手势；一次通常只清空输入或取消当前操作。
    for (let press = 0; press < 2; press += 1) {
      if (press > 0 && options.interruptGapMs > 0) await sleep(options.interruptGapMs);
      try {
        this.raw.write("\x03");
      } catch {
        // 进程可能恰好已退出；继续等待或回退强杀。
      }
    }
    const deadline = startedAt + options.interruptGapMs + options.graceMs;
    let gone = this.exited || !options.isAlive(this.pid);
    while (!gone && Date.now() < deadline) {
      // 轮询真实进程存活，而不是等 node-pty 的 exit 事件：后者比进程退出晚约 1 秒。
      await sleep(Math.min(CLOSE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      gone = this.exited || !options.isAlive(this.pid);
    }
    diagLog(`pty.graceful ${gone ? "exit" : "timeout"} ${Date.now() - startedAt}ms`);
    return gone;
  }

  /** @returns 首次调用终止原生进程，后续调用直接完成。 */
  async kill(): Promise<void> {
    if (this.killed || this.exited) return;
    this.killed = true;
    this.earlyData = [];
    this.diagnoseKill();
    this.diagnoseFork();
    const graceful = this.graceful;
    const exitedCleanly = graceful ? await this.interruptAndWait(graceful) : false;
    if (graceful && !exitedCleanly) {
      try {
        // 先结束控制台客户端，ClosePseudoConsole 才不会同步等满系统 5 秒宽限期。
        await graceful.killTree(this.pid);
      } catch {
        // 强杀失败时仍走原生关闭，最坏退化为原先的等待。
      }
    }
    const startedAt = Date.now();
    try {
      // 即使 CLI 已自行退出，也要关闭伪控制台释放句柄；此时不会再打断它的清理流程。
      this.raw.kill();
    } catch {
      // 优雅退出后套接字可能已被 node-pty 清理，关闭失败不影响结果。
    }
    diagLog(`pty.raw.kill ${Date.now() - startedAt}ms`);
  }
}

/** 直接在 Bun 编译进程中加载外置 node-pty 的后端。 */
export class BunPtyBackend implements PtyBackend {
  readonly kind = "bun-node-pty" as const;
  private module: NodePtyModule | undefined;
  private readonly processes = new Set<BunPtyProcess>();

  /** @param options 外置目录与可选模块加载器。 */
  constructor(private readonly options: BunPtyBackendOptions) {}

  /**
   * 启动真实 PTY。
   * @param options 已限制的启动参数。
   * @returns 统一 PTY 进程。
   * @throws {Error} 参数非法、外置模块缺失或原生 spawn 失败。
   */
  async spawn(options: PtySpawnOptions): Promise<PtyProcess> {
    validatePtySpawnOptions(options);
    const ptyRoot = path.join(this.options.executableDir, "pty");
    const requireModule = this.options.require
      ?? createRequire(path.join(ptyRoot, "package.json"));
    let module = this.module;
    if (!module) {
      const nativeEntry = path.join(ptyRoot, "node_modules", "node-pty", "lib", "index.js");
      // 绝对入口是 Bun 1.4.3 编译态已实探通过的加载方式。
      module = requireModule(nativeEntry) as NodePtyModule;
      this.module = module;
    }
    const nodePty = module;
    const platform = this.options.platform ?? process.platform;
    const spawnRaw = (): IPty => nodePty.spawn(options.file, options.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env ?? process.env,
      useConpty: platform === "win32",
    });
    let raw: IPty;
    try {
      raw = spawnRaw();
    } catch (error) {
      // Bun 的 require(".node") 在长路径下会让 LoadLibrary 失败；仅该阶段尚未创建 PTY，可安全重试一次。
      if (platform !== "win32" || !(error instanceof Error)
        || !error.message.includes("Failed to load native module: conpty.node")) {
        throw error;
      }
      const utilsPath = path.join(ptyRoot, "node_modules", "node-pty", "lib", "utils.js");
      const utils = requireModule(utilsPath) as NodePtyNativeUtils;
      const originalLoader = utils.loadNativeModule;
      if (typeof originalLoader !== "function") throw error;
      const nativePath = path.join(
        ptyRoot, "node_modules", "node-pty", "prebuilds",
        `win32-${this.options.arch ?? process.arch}`, "conpty.node",
      );
      const nativeModule: { exports: unknown } = { exports: {} };
      const dlopen = this.options.dlopen ?? (process.dlopen as unknown as NativeDlopen);
      dlopen(nativeModule, extendedWindowsPath(nativePath));
      utils.loadNativeModule = (name) => name === "conpty"
        ? { dir: "extended", module: nativeModule.exports }
        : originalLoader.call(utils, name);
      try {
        raw = spawnRaw();
      } finally {
        // 不留下进程级补丁；node-pty 已缓存本次成功加载的 conptyNative。
        utils.loadNativeModule = originalLoader;
      }
    }
    let proc: BunPtyProcess;
    proc = new BunPtyProcess(
      raw,
      () => this.processes.delete(proc),
      // 只有 Windows ConPTY 需要先优雅关闭再强杀；其它平台沿用原有信号关闭。
      platform === "win32" ? {
        killTree: this.options.killTree ?? killProcessTree,
        graceMs: this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
        interruptGapMs: this.options.closeInterruptGapMs ?? DEFAULT_INTERRUPT_GAP_MS,
        isAlive: this.options.isAlive ?? isProcessAlive,
      } : undefined,
    );
    this.processes.add(proc);
    return proc;
  }

  /** @returns 终止此后端仍拥有的全部 PTY。 */
  async close(): Promise<void> {
    await Promise.all([...this.processes].map((proc) => proc.kill()));
  }
}
