import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { diagLog } from "./startup-diagnostics";
import type { ProcessIdentity } from "./terminal-lease";

const execFileAsync = promisify(execFile);

/** 查询进程身份时可注入的 execFile；返回值与 promisify(execFile) 的 utf8 结果一致。 */
export type ProcessIdentityExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

/** 进程身份查询依赖；测试注入 execFile 以确定性地覆盖 shell 回退分支。 */
export interface ReadProcessIdentityDeps {
  execFile?: ProcessIdentityExecFile;
}

/**
 * Windows 查询 shell 的优先顺序。GitHub windows-latest 自带 PowerShell 7（pwsh.exe），
 * 冷启动通常数百毫秒；Windows PowerShell 5.1 在满载 runner 上曾超过 8 秒。
 */
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;

/** 单次身份查询上限。包装进程已改用自报身份，此路径只影响恢复核对，可留足 CI 余量。 */
const WINDOWS_QUERY_TIMEOUT_MS = 15_000;

/** 这些错误说明 shell 本身无法启动（不存在/不可执行），才值得换下一个候选。 */
const SHELL_UNAVAILABLE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EINVAL"]);

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
 * 自报启动时间与系统记录的允许偏差。进程只能记录自身初始化时刻，与 OS 创建时间
 * 相差加载耗时，CI 高负载下可达数秒；Windows 在一次开机内按递增计数器分配 PID，
 * 旧进程退出后不会立即复用，因此该容差不会把同路径的其他进程误认成原进程。
 */
const SELF_START_TOLERANCE_MS = 30_000;

/**
 * Windows 包装进程的自报身份：不启动 PowerShell，避免 CI 满载时冷启动超时阻断启动。
 * 路径取 process.execPath，与 Get-Process 返回的主模块路径一致；启动时间用当前时间
 * 减去进程 uptime 估算（Node 与 Bun 均支持），误差为进程初始化耗时。macOS 仍走
 * 精确的 ps 查询，返回 null。
 * @param platform 当前平台，默认取 process.platform
 * @returns Windows 下始终返回可用身份；其他平台返回 null，由调用方回退到系统查询
 */
export function selfProcessIdentity(
  platform: NodeJS.Platform = process.platform,
): ProcessIdentity | null {
  if (platform !== "win32") return null;
  const uptime = typeof process.uptime === "function" ? process.uptime() : 0;
  return {
    pid: process.pid,
    executable: normalizeExecutable(process.execPath),
    startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
    startedAtSource: "self",
  };
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
 * @param deps 可注入的 execFile；生产环境使用真实子进程
 * @returns 身份；进程不存在、查询失败或输出非法均返回 null
 */
export async function readProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  deps: ReadProcessIdentityDeps = {},
): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      // 不用 Get-CimInstance：首次查询会唤醒 WMI 服务，CI 冷启动常超过 3s 硬超时，
      // 包装进程拿不到身份就直接失败（2026-11-15 Windows CI 实测：首条用例超时、后续热查询通过）。
      // Get-Process 走系统进程 API（GetProcessTimes/MainModule），不经 WMI，本地约 155ms；
      // 输出格式与解析器保持一致：可执行路径一行、ISO 启动时间一行。
      // 临时诊断（2026-11-16）：脚本在 stderr 打印自身耗时，用于区分「shell 本身慢」与
      // 「桥接侧等待/回调延迟」；parseWindowsProcessIdentity 只读 stdout，不受影响。
      const script = `$sw=[Diagnostics.Stopwatch]::StartNew(); $p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.WriteLine($p.Path); [Console]::Out.WriteLine($p.StartTime.ToUniversalTime().ToString("o")); [Console]::Error.WriteLine("CCCPS elapsed=" + $sw.ElapsedMilliseconds)`;
      const exec: ProcessIdentityExecFile = deps.execFile
        ?? ((file, args, options) => execFileAsync(file, args, options));
      for (const [index, shell] of WINDOWS_SHELL_CANDIDATES.entries()) {
        const startedAt = Date.now();
        diagLog(`identity pid=${pid} start shell=${shell}`);
        try {
          const { stdout, stderr } = await exec(shell, [
            "-NoProfile", "-NonInteractive", "-Command", script,
          ], { timeout: WINDOWS_QUERY_TIMEOUT_MS, maxBuffer: 8192, windowsHide: true });
          const psElapsed = /CCCPS elapsed=(\d+)/.exec(String(stderr))?.[1] ?? "n/a";
          diagLog(`identity pid=${pid} ok shell=${shell} wait=${Date.now() - startedAt}ms ps=${psElapsed}ms`);
          return parseWindowsProcessIdentity(String(stdout), pid);
        } catch (error) {
          // 诊断分支保持原有降级语义：任何失败都不向调用方暴露细节。
          const code = (error as NodeJS.ErrnoException).code;
          const shellUnavailable = typeof code === "string" && SHELL_UNAVAILABLE_CODES.has(code);
          diagLog(`identity pid=${pid} FAILED shell=${shell} wait=${Date.now() - startedAt}ms `
            + `${code ?? ""} ${String((error as Error).message ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
          // 只有 shell 本身拉不起来才换候选；进程不存在、权限或超时与 shell 无关，
          // 再启动一个只会把等待翻倍并错过测试期限。
          if (!shellUnavailable || index === WINDOWS_SHELL_CANDIDATES.length - 1) return null;
        }
      }
      return null;
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
 * @returns 三项全部匹配才为 true；自报启动时间按初始化偏差容差比较
 */
export async function matchesProcessIdentity(
  expected: ProcessIdentity,
  query: (pid: number) => Promise<ProcessIdentity | null> = readProcessIdentity,
): Promise<boolean> {
  const actual = await query(expected.pid);
  if (!actual || actual.pid !== expected.pid) return false;
  if (normalizeExecutable(actual.executable) !== normalizeExecutable(expected.executable)) {
    return false;
  }
  const expectedStart = Date.parse(expected.startedAt);
  const actualStart = Date.parse(actual.startedAt);
  return expected.startedAtSource === "self"
    ? Math.abs(actualStart - expectedStart) <= SELF_START_TOLERANCE_MS
    : actualStart === expectedStart;
}
