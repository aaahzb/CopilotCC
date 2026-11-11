import * as path from "node:path";
import { BunPtyBackend } from "./bun-pty-backend";
import { NodePtyBackend } from "./node-pty-backend";

/** 启动一个真实伪终端所需的受限参数。 */
export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

/** 伪终端退出事件；没有信号时统一为 null。 */
export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

/** 两条原生路线共同暴露的最小 PTY 进程接口。 */
export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
}

/** 可关闭的原生 PTY 后端。 */
export interface PtyBackend {
  readonly kind: "bun-node-pty" | "node-helper";
  spawn(options: PtySpawnOptions): Promise<PtyProcess>;
  close(): Promise<void>;
}

/** node-pty 的可注入窄接口，避免测试依赖本机原生模块。 */
export type NodePtyModule = Pick<typeof import("node-pty"), "spawn">;

/**
 * 校验来自内部协议边界的 PTY 启动参数。
 * @param value 待校验的未知值。
 * @returns 无显式返回值；通过类型断言收窄为 PtySpawnOptions。
 * @throws {Error} cwd 非绝对路径、命令为空、参数类型错误或尺寸越界。
 */
export function validatePtySpawnOptions(value: unknown): asserts value is PtySpawnOptions {
  if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST");
  const options = value as Record<string, unknown>;
  const validDimensions = Number.isInteger(options.cols)
    && Number(options.cols) >= 2 && Number(options.cols) <= 500
    && Number.isInteger(options.rows) && Number(options.rows) >= 2 && Number(options.rows) <= 200;
  const validEnv = options.env === undefined || (
    typeof options.env === "object" && options.env !== null && !Array.isArray(options.env)
    && Object.values(options.env).every((entry) => entry === undefined || typeof entry === "string")
  );
  if (typeof options.file !== "string" || options.file.length === 0
    || typeof options.cwd !== "string" || !path.isAbsolute(options.cwd)
    || !Array.isArray(options.args) || !options.args.every((arg) => typeof arg === "string")
    || !validDimensions || !validEnv) {
    throw new Error("INVALID_REQUEST");
  }
}

/**
 * 创建指定 PTY 路线；构造阶段不加载原生模块或启动 helper。
 * @param kind 已由真实探针选择的路线。
 * @param executableDir 桥接可执行文件所在目录。
 * @returns 对应路线的 PTY 后端。
 */
export function createPtyBackend(kind: PtyBackend["kind"], executableDir: string): PtyBackend {
  if (kind === "bun-node-pty") return new BunPtyBackend({ executableDir });
  return new NodePtyBackend({
    nodePath: path.join(executableDir, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    helperPath: path.join(executableDir, "pty", "helper.cjs"),
  });
}
