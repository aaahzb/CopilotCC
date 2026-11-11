import { createRequire } from "node:module";
import * as path from "node:path";
import type { IPty } from "node-pty";
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
   */
  constructor(private readonly raw: IPty, onExit: () => void) {
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
      this.exitEvent = { exitCode, signal: signal ?? null };
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

  /** @returns 首次调用终止原生进程，后续调用直接完成。 */
  async kill(): Promise<void> {
    if (this.killed || this.exited) return;
    this.killed = true;
    this.earlyData = [];
    this.raw.kill();
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
    proc = new BunPtyProcess(raw, () => this.processes.delete(proc));
    this.processes.add(proc);
    return proc;
  }

  /** @returns 终止此后端仍拥有的全部 PTY。 */
  async close(): Promise<void> {
    await Promise.all([...this.processes].map((proc) => proc.kill()));
  }
}
