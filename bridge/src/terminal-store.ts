import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UUID_RE } from "./protocol";
import type { TerminalLeaseRecord } from "./terminal-lease";

const BACKENDS = new Set(["windows-terminal", "windows-console", "terminal-app", "pty"]);
const PHASES = new Set(["starting", "active", "degraded", "stopping"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableUuid(value: unknown): boolean {
  return value === null || (typeof value === "string" && UUID_RE.test(value));
}

function isValidRecord(value: unknown): value is TerminalLeaseRecord {
  if (!isObject(value)) return false;
  if (typeof value.leaseId !== "string" || !UUID_RE.test(value.leaseId)) return false;
  if (typeof value.hookToken !== "string" || !value.hookToken || value.hookToken.length > 512) return false;
  if (value.mode !== "system" && value.mode !== "embedded") return false;
  if (typeof value.folder !== "string" || !value.folder) return false;
  if (!isNullableUuid(value.initialSessionId) || !isNullableUuid(value.currentSessionId)
    || !isNullableUuid(value.confirmedSessionId)) return false;
  if (typeof value.resumeSessionId !== "string" || !UUID_RE.test(value.resumeSessionId)) return false;
  if (typeof value.cliPath !== "string" || !value.cliPath) return false;
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) return false;
  if (typeof value.privateDir !== "string" || !value.privateDir) return false;
  if (typeof value.phase !== "string" || !PHASES.has(value.phase)) return false;
  if (value.backend !== null && (typeof value.backend !== "string" || !BACKENDS.has(value.backend))) return false;
  if (value.pid !== null && (!Number.isInteger(value.pid) || (value.pid as number) <= 0)) return false;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (typeof value.canManualRelease !== "boolean") return false;
  if (value.message !== undefined && typeof value.message !== "string") return false;
  if (value.identity !== undefined) {
    const identity = value.identity;
    if (!isObject(identity) || !Number.isInteger(identity.pid) || (identity.pid as number) <= 0
      || typeof identity.executable !== "string" || !identity.executable
      || typeof identity.startedAt !== "string" || !identity.startedAt) return false;
  }
  return true;
}

const RETRYABLE_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * 原子替换私有 lease；Windows 病毒扫描或并发读取造成短暂占用时进行有界重试。
 * @param temp 本次新建且内容完整的临时文件
 * @param file 最终 lease 文件
 * @returns 替换成功后无返回值
 * @throws 非暂时性错误或三次替换均失败时继续抛出，调用方仍保持只读屏障
 */
function renameWithRetry(temp: string, file: string): void {
  const retryBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_RENAME_ERRORS.has(code) || attempt === 3) throw error;
      Atomics.wait(retryBuffer, 0, 0, attempt * 5); // 仅异常路径短暂等待，正常保存不阻塞事件循环。
    }
  }
}

/** 将系统终端 lease 原子保存在桥接私有目录，供桥接重启后核对。 */
export class TerminalLeaseStore {
  constructor(private readonly file: string) {}

  /**
   * 读取并严格校验私有 lease。
   * @returns 合法记录；文件不存在、坏 JSON 或字段非法时返回 null
   * @throws 除文件不存在外的文件系统读取错误继续抛出，避免误判为无 lease
   */
  load(): TerminalLeaseRecord | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(raw);
      return isValidRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * 通过同目录临时文件和 rename 原子替换 lease 记录。
   * @param record 含 hook token 的服务端私有记录，不得广播给扩展
   */
  save(record: TerminalLeaseRecord): void {
    if (!isValidRecord(record)) throw new Error("INVALID_TERMINAL_LEASE");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(record, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameWithRetry(temp, this.file);
    } finally {
      // rename 成功后临时路径已不存在；失败时只清理本次新建文件。
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  /**
   * 仅当磁盘记录仍属于指定 lease 时删除，避免旧退出事件清除新 lease。
   * @param leaseId 已结束的 lease
   */
  clear(leaseId: string): void {
    const current = this.load();
    if (current?.leaseId !== leaseId) return;
    try {
      fs.unlinkSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
