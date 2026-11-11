import { createRequire } from "node:module";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { IPty } from "node-pty";
import {
  validatePtySpawnOptions,
  type NodePtyModule,
  type PtySpawnOptions,
} from "./pty-backend";

const MAX_FRAME_BYTES = 1_048_576;

/** helper 接收的本地 JSONL 请求。 */
export type HelperRequest =
  | { type: "start"; id: number; options: PtySpawnOptions }
  | { type: "write"; id: number; data: string }
  | { type: "resize"; id: number; cols: number; rows: number }
  | { type: "kill"; id: number };

/** helper 运行依赖，可用内存流和假原生模块测试。 */
export interface NodePtyHelperDependencies {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  pty?: NodePtyModule;
}

interface HelperRecord {
  raw: IPty;
  killed: boolean;
  exited: boolean;
}

/**
 * 严格解析一条 helper 请求。
 * @param value JSON 解析后的未知值。
 * @returns 已校验的 HelperRequest。
 * @throws {Error} id、类型、启动参数或控制参数非法。
 */
export function parseHelperRequest(value: unknown): HelperRequest {
  if (!value || typeof value !== "object") throw new Error("INVALID_REQUEST");
  const frame = value as Record<string, unknown>;
  if (!Number.isSafeInteger(frame.id) || Number(frame.id) <= 0 || typeof frame.type !== "string") {
    throw new Error("INVALID_REQUEST");
  }
  if (frame.type === "start") {
    validatePtySpawnOptions(frame.options);
    return frame as unknown as HelperRequest;
  }
  if (frame.type === "write" && typeof frame.data === "string") return frame as unknown as HelperRequest;
  if (frame.type === "resize" && validDimension(frame.cols, 2, 500) && validDimension(frame.rows, 2, 200)) {
    return frame as unknown as HelperRequest;
  }
  if (frame.type === "kill") return frame as unknown as HelperRequest;
  throw new Error("INVALID_REQUEST");
}

/** @param value 待检查值。 @param min 最小值。 @param max 最大值。 @returns 是否为范围内整数。 */
function validDimension(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

/** @param helperDir helper.cjs 所在目录。 @returns 外置 node-pty 模块。 */
function loadNativeModule(helperDir: string): NodePtyModule {
  const externalRequire = createRequire(path.join(helperDir, "package.json"));
  const nativeEntry = path.join(helperDir, "node_modules", "node-pty", "lib", "index.js");
  return externalRequire(nativeEntry) as NodePtyModule;
}

/**
 * 在受限 stdin/stdout JSONL 管道上运行 node-pty helper。
 * @param dependencies 输入、输出和可选原生模块。
 * @returns 无；输入关闭时终止其拥有的全部 PTY。
 */
export function runNodePtyHelper(dependencies: NodePtyHelperDependencies): void {
  const { input, output } = dependencies;
  const pty = dependencies.pty ?? loadNativeModule(path.dirname(process.argv[1] ?? process.execPath));
  const records = new Map<number, HelperRecord>();
  const decoder = new StringDecoder("utf8");
  let buffered = "";

  /** @param frame 协议输出帧。 @returns 无。 */
  function send(frame: Record<string, unknown>): void {
    output.write(`${JSON.stringify(frame)}\n`);
  }

  /** @param id 相关请求 id。 @param code 固定错误码。 @param error 可选本地异常。 @returns 无。 */
  function sendError(id: number | null, code: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "request failed";
    send({ type: "error", id, code, message: detail.slice(0, 500) });
  }

  /** @param id 请求 id。 @param record 已启动原生进程。 @returns 无。 */
  function killRecord(id: number, record: HelperRecord): void {
    if (record.killed || record.exited) return;
    record.killed = true;
    try {
      record.raw.kill();
    } catch (error) {
      sendError(id, "KILL_FAILED", error);
    }
  }

  /** @returns 输入管道结束时清理全部自有进程。 */
  function killAll(): void {
    for (const [id, record] of records) killRecord(id, record);
  }

  /** @param request 已校验启动请求。 @returns 无。 */
  function start(request: Extract<HelperRequest, { type: "start" }>): void {
    if (records.has(request.id)) {
      sendError(request.id, "DUPLICATE_ID");
      return;
    }
    let raw: IPty;
    try {
      raw = pty.spawn(request.options.file, request.options.args, {
        name: "xterm-256color",
        cols: request.options.cols,
        rows: request.options.rows,
        cwd: request.options.cwd,
        env: request.options.env ?? process.env,
        useConpty: process.platform === "win32",
      });
    } catch (error) {
      sendError(request.id, "SPAWN_FAILED", error);
      return;
    }
    const record: HelperRecord = { raw, killed: false, exited: false };
    records.set(request.id, record);
    raw.onData((data) => {
      if (!record.killed && !record.exited) send({ type: "data", id: request.id, data });
    });
    raw.onExit(({ exitCode, signal }) => {
      if (record.exited) return;
      record.exited = true;
      records.delete(request.id);
      send({ type: "exit", id: request.id, exitCode, signal: signal ?? null });
    });
    send({ type: "started", id: request.id, pid: raw.pid });
  }

  /** @param request 一条已校验请求。 @returns 无。 */
  function dispatch(request: HelperRequest): void {
    if (request.type === "start") {
      start(request);
      return;
    }
    const record = records.get(request.id);
    if (request.type === "kill") {
      // 重复 kill 和进程已退出均为成功的幂等清理。
      if (record) killRecord(request.id, record);
      return;
    }
    if (!record || record.killed || record.exited) {
      sendError(request.id, "NOT_FOUND");
      return;
    }
    try {
      if (request.type === "write") record.raw.write(request.data);
      else record.raw.resize(request.cols, request.rows);
    } catch (error) {
      sendError(request.id, request.type === "write" ? "WRITE_FAILED" : "RESIZE_FAILED", error);
    }
  }

  /** @param line 一条不含换行的 JSONL 输入。 @returns 无。 */
  function acceptLine(line: string): void {
    if (!line) return;
    let id: number | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).id === "number") {
        id = (parsed as Record<string, unknown>).id as number;
      }
      dispatch(parseHelperRequest(parsed));
    } catch (error) {
      const code = error instanceof Error && error.message === "INVALID_REQUEST" ? "INVALID_REQUEST" : "INVALID_JSON";
      sendError(id, code, code);
    }
  }

  input.on("data", (chunk: Buffer | string) => {
    buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(buffered, "utf8") > MAX_FRAME_BYTES && !buffered.includes("\n")) {
      sendError(null, "FRAME_TOO_LARGE", "FRAME_TOO_LARGE");
      buffered = "";
      (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return;
    }
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        sendError(null, "FRAME_TOO_LARGE", "FRAME_TOO_LARGE");
        buffered = "";
        (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        return;
      }
      acceptLine(line);
      newline = buffered.indexOf("\n");
    }
  });
  input.on("close", killAll);
  input.on("end", killAll);
}

// 只有作为显式 helper 入口运行时才接管 stdin；Vitest 导入不会启动服务。
const entryName = path.basename(process.argv[1] ?? "");
if (entryName === "helper.cjs" || entryName === "node-pty-helper.ts") {
  runNodePtyHelper({ input: process.stdin, output: process.stdout });
}
