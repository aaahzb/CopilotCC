import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProcessIdentity } from "./terminal-lease";

const execFileAsync = promisify(execFile);

/**
 * 仅在操作系统明确报告 ESRCH 时认定进程已退出；权限及瞬时查询错误一律保持未知。
 * @param pid 正整数进程 ID
 * @param probe 默认使用 signal 0 的无副作用存活探测
 * @returns 进程存活或状态未知时为 true，只有明确不存在时为 false
 */
export function isProcessAlive(
  pid: number,
  probe: (pid: number) => void = (targetPid) => process.kill(targetPid, 0),
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** @param value 原生可执行路径 @returns 统一斜杠的路径，Windows 比较时再忽略大小写 */
function normalizeExecutable(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 解析 PowerShell 的两行私有查询结果。
 * @param stdout 可执行路径与 ISO 启动时间
 * @param pid 被查询 PID
 * @returns 完整身份；字段缺失或时间非法返回 null
 */
export function parseWindowsProcessIdentity(stdout: string, pid: number): ProcessIdentity | null {
  const [executable = "", startedAt = ""] = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!executable || !Number.isFinite(Date.parse(startedAt))) return null;
  return {
    pid,
    executable: executable.replace(/\\/g, "/"),
    startedAt: new Date(startedAt).toISOString(),
  };
}

/**
 * 解析 macOS `ps -o comm= -o lstart=` 的单行结果。
 * @param stdout 程序路径及五段 lstart 时间
 * @param pid 被查询 PID
 * @returns 完整身份；格式无法确认时返回 null
 */
export function parseMacProcessIdentity(stdout: string, pid: number): ProcessIdentity | null {
  const match = /^(.*?)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/m.exec(stdout.trim());
  if (!match?.[1] || !match[2] || !Number.isFinite(Date.parse(match[2]))) return null;
  return { pid, executable: match[1], startedAt: new Date(match[2]).toISOString() };
}

/**
 * 查询指定 PID 的真实程序路径和 OS 启动时间，不打印查询输出。
 * @param pid 正整数进程 ID
 * @param platform 当前平台，仅 Windows/macOS 在支持范围内
 * @returns 身份；进程不存在、查询失败或输出非法均返回 null
 */
export async function readProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit 3 }; [Console]::Out.WriteLine($p.ExecutablePath); [Console]::Out.WriteLine($p.CreationDate.ToUniversalTime().ToString("o"))`;
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", script,
      ], { timeout: 3000, maxBuffer: 8192, windowsHide: true });
      return parseWindowsProcessIdentity(stdout, pid);
    }
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", [
        "-p", String(pid), "-o", "comm=", "-o", "lstart=",
      ], {
        timeout: 3000,
        maxBuffer: 8192,
        windowsHide: true,
        // lstart 会跟随系统区域设置本地化；固定子进程 Locale，保留可严格解析的稳定格式。
        env: { ...process.env, LC_ALL: "C" },
      });
      return parseMacProcessIdentity(stdout, pid);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 同时核对 PID、程序路径和启动时间，拒绝 PID 复用造成的假存活。
 * @param expected 私有 lease 保存的身份
 * @param query 可注入的真实查询
 * @returns 三项全部匹配才为 true
 */
export async function matchesProcessIdentity(
  expected: ProcessIdentity,
  query: (pid: number) => Promise<ProcessIdentity | null> = readProcessIdentity,
): Promise<boolean> {
  const actual = await query(expected.pid);
  if (!actual || actual.pid !== expected.pid) return false;
  return normalizeExecutable(actual.executable) === normalizeExecutable(expected.executable)
    && Date.parse(actual.startedAt) === Date.parse(expected.startedAt);
}
