import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UUID_RE } from "./protocol";
import { normalizeFolder } from "./session-manager";
import type { TerminalLeaseRecord, TerminalSessionEvent, TerminalStartContext } from "./terminal-lease";
import { slugifyPath } from "./transcript";

export type TerminalHookTransport = "http" | "command";
export type HookValidationError = "TOKEN" | "CWD" | "TRANSCRIPT";

/** HTTP Hook 与服务端 lease 的窄连接，避免把私有记录暴露到公开协议。 */
export interface TerminalHookHttpDeps {
  currentRecord(): TerminalLeaseRecord | null;
  confirmSession(leaseId: string, event: TerminalSessionEvent): boolean;
  projectsRoot: string;
}

const START_SOURCES = new Set(["startup", "resume", "clear", "compact", "fork"]);
const END_REASONS = new Set(["clear", "resume", "logout", "prompt_input_exit", "other"]);

/**
 * 生成只作用于本次终端进程的 Claude Hook 配置。
 * @param context 当前 lease 私有启动上下文
 * @param transport HTTP 或旧版 CLI 的 command 转发
 * @param helperCommand command 模式必需的本地 helper 命令
 * @returns 可写入私有 settings 文件的配置对象
 * @throws command 模式缺少 helper 时抛出 HOOK_HELPER_REQUIRED
 */
export function terminalSettings(
  context: TerminalStartContext,
  transport: TerminalHookTransport,
  helperCommand?: string,
): Record<string, unknown> {
  if (transport === "command" && !helperCommand) throw new Error("HOOK_HELPER_REQUIRED");
  const url = `http://127.0.0.1:${context.port}/terminal-hook/${context.leaseId}`;
  const hook = transport === "http"
    ? {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${context.hookToken}` },
        timeout: 5,
      }
    : { type: "command", command: helperCommand!, timeout: 5 };
  return {
    hooks: {
      SessionStart: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  };
}

/**
 * 将本次 Hook settings 写入私有目录；command token 使用独立私有文件。
 * @param context 当前 lease 私有启动上下文
 * @param transport Hook 传输方式
 * @param helperCommand command 模式 helper 命令
 * @returns settings 文件绝对路径
 */
export function writeTerminalSettings(
  context: TerminalStartContext,
  transport: TerminalHookTransport = "http",
  helperCommand?: string,
): string {
  const file = path.join(context.privateDir, `${context.leaseId}.settings.json`);
  fs.mkdirSync(context.privateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(terminalSettings(context, transport, helperCommand), null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  if (transport === "command") {
    fs.writeFileSync(path.join(context.privateDir, `${context.leaseId}.hook-token`), context.hookToken, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return file;
}

/**
 * 解析 CLI Hook 的不可信 JSON，并只保留已知事件字段。
 * @param input JSON 字符串或已解析值
 * @returns 严格事件对象；字段、UUID 或枚举非法时返回 null
 */
export function parseHookEvent(input: unknown): TerminalSessionEvent | null {
  try {
    const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.session_id !== "string" || !UUID_RE.test(raw.session_id)) return null;
    if (typeof raw.cwd !== "string" || !path.isAbsolute(raw.cwd) || raw.cwd.length > 32_768) return null;
    if (typeof raw.transcript_path !== "string" || !path.isAbsolute(raw.transcript_path)
      || raw.transcript_path.length > 32_768) return null;
    const base = {
      sessionId: raw.session_id,
      cwd: raw.cwd,
      transcriptPath: raw.transcript_path,
    };
    if (raw.hook_event_name === "SessionStart") {
      if (typeof raw.source !== "string" || !START_SOURCES.has(raw.source)) return null;
      return {
        ...base,
        event: "SessionStart",
        source: raw.source as TerminalSessionEvent["source"],
      };
    }
    if (raw.hook_event_name === "SessionEnd") {
      if (typeof raw.reason !== "string" || !END_REASONS.has(raw.reason)) return null;
      return {
        ...base,
        event: "SessionEnd",
        reason: raw.reason as TerminalSessionEvent["reason"],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 使用常量时间比较等长 token，不输出或记录任何 token 内容。
 * @param actual 请求携带的 token
 * @param expected lease 私有 token
 * @returns 是否完全一致
 */
export function safeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 校验 Hook 的 token、cwd 和预期转录路径，事件路径不能扩大文件读取授权。
 * @param record 当前私有 lease
 * @param token 请求 Bearer token
 * @param event 已严格解析的事件
 * @param projectsRoot 现有 transcript 模块解析出的 projects 根目录
 * @returns 合法返回 null，否则返回固定错误码
 */
export function validateHookEvent(
  record: TerminalLeaseRecord,
  token: string,
  event: TerminalSessionEvent,
  projectsRoot: string,
): HookValidationError | null {
  if (!safeTokenEqual(token, record.hookToken)) return "TOKEN";
  if (normalizeFolder(event.cwd) !== normalizeFolder(record.folder)) return "CWD";
  const expected = path.join(
    projectsRoot,
    slugifyPath(path.resolve(record.folder)),
    `${event.sessionId}.jsonl`,
  );
  if (normalizeFolder(event.transcriptPath) !== normalizeFolder(expected)) return "TRANSCRIPT";
  return null;
}

/**
 * 读取最大 64 KiB 的 Hook 请求体，超限即失败且不回显内容。
 * @param input HTTP 请求或 helper stdin
 * @returns UTF-8 请求文本
 * @throws 超过限制时抛出 HOOK_BODY_TOO_LARGE
 */
export async function readHookJson(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    size += chunk.length;
    if (size > 65_536) throw new Error("HOOK_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 处理固定 lease 路径的回环 Hook 请求，只返回固定错误码。
 * @param req 本机 HTTP 请求
 * @param res HTTP 响应
 * @param deps 当前私有 lease 与事件确认接口
 * @returns 请求处理完成的 Promise
 */
export async function handleTerminalHookHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TerminalHookHttpDeps,
): Promise<void> {
  const reply = (status: number, code: string): void => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ code }));
  };
  if (req.method !== "POST") {
    reply(405, "METHOD_NOT_ALLOWED");
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const match = /^\/terminal-hook\/([0-9a-f-]+)$/.exec(pathname);
  const leaseId = match?.[1];
  const record = deps.currentRecord();
  if (!leaseId || !UUID_RE.test(leaseId) || !record || record.leaseId !== leaseId) {
    reply(404, "HOOK_NOT_FOUND");
    return;
  }
  const authorization = req.headers.authorization;
  const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!safeTokenEqual(token, record.hookToken)) {
    reply(401, "HOOK_UNAUTHORIZED");
    return;
  }
  try {
    const event = parseHookEvent(await readHookJson(req));
    if (!event) {
      reply(422, "HOOK_INVALID");
      return;
    }
    const validation = validateHookEvent(record, token, event, deps.projectsRoot);
    if (validation) {
      reply(validation === "TOKEN" ? 401 : 422, `HOOK_${validation}`);
      return;
    }
    if (!deps.confirmSession(leaseId, event)) {
      reply(409, "HOOK_NOT_ACTIVE");
      return;
    }
    reply(200, "OK");
  } catch (error) {
    if (error instanceof Error && error.message === "HOOK_BODY_TOO_LARGE") {
      reply(413, "HOOK_BODY_TOO_LARGE");
      return;
    }
    reply(422, "HOOK_INVALID");
  }
}
