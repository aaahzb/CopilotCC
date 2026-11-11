import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { probeCliVersion, selectHookTransport } from "./cli-capabilities";
import { isProcessAlive } from "./process-identity";
import { UUID_RE, type TerminalBackend } from "./protocol";
import { terminalChildCommand, terminalHookCommand, type TerminalChildCommand } from "./runtime-entry";
import type { TerminalChildRequest } from "./terminal-child";
import { writeTerminalSettings } from "./terminal-hooks";
import type {
  ProcessIdentity,
  TerminalLeaseRecord,
  TerminalRuntimeHandle,
  TerminalStartContext,
} from "./terminal-lease";

export interface SystemTerminalDeps {
  platform?: NodeJS.Platform;
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  which?: (executable: string) => string | null;
  childCommand?: TerminalChildCommand;
  probeVersion?: (cliPath: string) => Promise<string>;
  /** 活跃期间核对包装 PID；只有明确 ESRCH 才允许无退出文件时完成退出 */
  isProcessAlive?: (pid: number) => boolean;
}

/** @param value 任意 shell 参数 @returns 可安全嵌入 POSIX shell 命令的单引号参数 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** @param executable 程序名 @returns PATH 中首个匹配绝对路径；未找到返回 null */
function findExecutable(executable: string): string | null {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() || null : null;
}

/** @param file 私有退出文件 @param leaseId 当前 lease @returns 合法退出记录，否则 null */
function readExit(file: string, leaseId: string): { exitCode: number | null; reason: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (value.leaseId !== leaseId || typeof value.reason !== "string"
      || !(value.exitCode === null || typeof value.exitCode === "number")) return null;
    return { exitCode: value.exitCode as number | null, reason: value.reason };
  } catch {
    return null;
  }
}

/** @param record 私有系统 lease @returns 是否已有内容合法且属于该 lease 的真实退出记录 */
export function hasTerminalExit(record: Pick<TerminalLeaseRecord, "leaseId" | "privateDir">): boolean {
  const file = path.join(record.privateDir, `${record.leaseId}.exit.json`);
  return readExit(file, record.leaseId) !== null;
}

/** Windows Terminal、可见控制台与 Terminal.app 共用的系统终端适配器。 */
export class SystemTerminalAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly spawnImpl: NonNullable<SystemTerminalDeps["spawn"]>;
  private readonly which: NonNullable<SystemTerminalDeps["which"]>;
  private readonly childCommand: TerminalChildCommand;
  private readonly probeVersion: NonNullable<SystemTerminalDeps["probeVersion"]>;
  private readonly isProcessAlive: NonNullable<SystemTerminalDeps["isProcessAlive"]>;

  /** @param deps 平台与进程依赖；测试必须注入假 spawn，避免打开真实窗口 */
  constructor(deps: SystemTerminalDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.spawnImpl = deps.spawn ?? spawn;
    this.which = deps.which ?? findExecutable;
    this.childCommand = deps.childCommand ?? terminalChildCommand();
    this.probeVersion = deps.probeVersion ?? probeCliVersion;
    this.isProcessAlive = deps.isProcessAlive ?? isProcessAlive;
  }

  /**
   * 创建不含 token 的私有请求并拉起可见终端，随后等待包装进程写入完整身份。
   * @param context 当前 lease 启动上下文
   * @returns 后端、包装 PID/身份及停止与退出监控句柄
   * @throws 不支持平台、启动失败或状态超时则抛固定错误
   */
  async start(context: TerminalStartContext): Promise<TerminalRuntimeHandle> {
    if (this.platform !== "win32" && this.platform !== "darwin") {
      throw new Error("TERMINAL_PLATFORM_UNSUPPORTED");
    }
    fs.mkdirSync(context.privateDir, { recursive: true, mode: 0o700 });
    const transport = selectHookTransport(await this.probeVersion(context.cliPath));
    const helperCommand = transport === "command"
      ? terminalHookCommand(context.leaseId, this.childCommand)
      : undefined;
    const settingsFile = writeTerminalSettings(context, transport, helperCommand);
    const requestFile = path.join(context.privateDir, `${context.leaseId}.request.json`);
    const exitFile = path.join(context.privateDir, `${context.leaseId}.exit.json`);
    const stopFile = path.join(context.privateDir, `${context.leaseId}.stop`);
    const request: TerminalChildRequest = {
      leaseId: context.leaseId,
      cwd: context.folder,
      cliPath: context.cliPath,
      args: [
        ...(context.initialSessionId
          ? ["--resume", context.initialSessionId]
          : ["--session-id", context.resumeSessionId]),
        "--settings", settingsFile,
      ],
      exitFile,
      stopFile,
      ...(transport === "command" ? {
        hookUrl: `http://127.0.0.1:${context.port}/terminal-hook/${context.leaseId}`,
        hookTokenFile: path.join(context.privateDir, `${context.leaseId}.hook-token`),
      } : {}),
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), { encoding: "utf8", mode: 0o600 });

    let backend: TerminalBackend;
    if (this.platform === "win32") {
      const launcher = path.join(context.privateDir, `${context.leaseId}.cmd`);
      const childArgs = [...this.childCommand.prefixArgs, "--terminal-child", requestFile]
        .map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" ");
      fs.writeFileSync(launcher, `@echo off\r\n"${this.childCommand.executable}" ${childArgs}\r\n`, {
        encoding: "utf8", mode: 0o600,
      });
      const wt = this.which("wt.exe");
      if (wt) {
        backend = "windows-terminal";
        this.spawnImpl(wt, ["-d", context.folder, "cmd.exe", "/d", "/c", launcher], {
          detached: true, stdio: "ignore", windowsHide: false,
        });
      } else {
        backend = "windows-console";
        this.spawnImpl("cmd.exe", ["/c", "start", "CopilotCC Terminal", "/D", context.folder, launcher], {
          detached: true, stdio: "ignore", windowsHide: false,
        });
      }
    } else {
      backend = "terminal-app";
      const command = [
        `cd ${shellQuote(context.folder)}`,
        [this.childCommand.executable, ...this.childCommand.prefixArgs, "--terminal-child", requestFile]
          .map(shellQuote).join(" "),
      ].join(" && ");
      // 命令经 argv 传入 AppleScript，避免路径中的引号被二次解释。
      this.spawnImpl("osascript", [
        "-e", "on run argv",
        "-e", 'tell application "Terminal"',
        "-e", "activate",
        "-e", "do script (item 1 of argv)",
        "-e", "end tell",
        "-e", "end run",
        command,
      ], { detached: true, stdio: "ignore", windowsHide: false });
    }

    let status: ProcessIdentity;
    try {
      status = await this.waitForStatus(context);
      // 只有桥接已接管该 lease 后，包装进程才允许启动真实 CLI。
      fs.writeFileSync(path.join(context.privateDir, `${context.leaseId}.start`), "", {
        encoding: "utf8", mode: 0o600,
      });
    } catch (error) {
      // 最终失败必须撤销迟到包装进程的启动资格，但不能用清理错误覆盖原始错误。
      try {
        fs.writeFileSync(path.join(context.privateDir, `${context.leaseId}.cancel`), "", {
          encoding: "utf8", mode: 0o600,
        });
      } catch {
        // 没有 .start 时包装进程同样不会启动，取消文件写入失败不放宽该门槛。
      }
      throw error;
    }
    return this.createHandle(context, status, exitFile, stopFile, backend);
  }

  /**
   * 接管既有系统包装进程的退出文件，不执行 GUI 启动器也不重新启动 Claude。
   * @param record 身份已核对或已有真实退出文件的私有 lease
   * @returns 与原运行时相同语义的退出监控和停止文件句柄
   * @throws 记录缺少已确认后端或进程身份时抛出 TERMINAL_RECOVERY_INVALID
   */
  recover(record: TerminalLeaseRecord): TerminalRuntimeHandle {
    if (record.mode !== "system" || !record.backend || !record.identity) {
      throw new Error("TERMINAL_RECOVERY_INVALID");
    }
    return this.createHandle(
      record,
      record.identity,
      path.join(record.privateDir, `${record.leaseId}.exit.json`),
      path.join(record.privateDir, `${record.leaseId}.stop`),
      record.backend,
    );
  }

  /** @param context 当前 lease @returns 包装进程写出的身份；20秒无合法状态则失败 */
  private async waitForStatus(context: TerminalStartContext): Promise<ProcessIdentity> {
    const file = path.join(context.privateDir, `${context.leaseId}.status.json`);
    const deadline = Date.now() + 20_000;
    while (Date.now() <= deadline) {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (value.leaseId === context.leaseId && typeof value.pid === "number"
          && Number.isInteger(value.pid) && value.pid > 0 && typeof value.executable === "string"
          && value.executable && typeof value.startedAt === "string"
          && Number.isFinite(Date.parse(value.startedAt))) {
          return { pid: value.pid, executable: value.executable, startedAt: value.startedAt };
        }
      } catch {
        // 包装进程可能尚未写完，继续等待，不把半个 JSON 当成启动失败。
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("TERMINAL_STATUS_TIMEOUT");
  }

  /**
   * 监控真实 CLI 退出文件；GUI 启动器退出不释放 lease。
   * @returns 仅允许通过停止文件请求结束，不直接猜杀 PID
   */
  private createHandle(
    context: TerminalStartContext,
    identity: ProcessIdentity,
    exitFile: string,
    stopFile: string,
    backend: TerminalBackend,
  ): TerminalRuntimeHandle {
    const callbacks = new Set<(exitCode: number | null, reason?: string) => void>();
    let finished = false;
    const notify = (result: { exitCode: number | null; reason: string }): void => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      for (const callback of callbacks) callback(result.exitCode, result.reason);
    };
    const timer = setInterval(() => {
      const result = readExit(exitFile, context.leaseId);
      if (result) {
        notify(result);
      } else if (!this.isProcessAlive(identity.pid)) {
        // Windows Terminal 关窗可能直接结束整个进程树，包装进程来不及写 exit.json。
        // isProcessAlive 只有明确 ESRCH 才返回 false；权限/查询错误仍保持只读。
        notify({ exitCode: null, reason: "process-exit" });
      }
    }, 100);
    timer.unref();
    return {
      pid: identity.pid,
      backend,
      identity,
      onExit: (callback): void => {
        callbacks.add(callback);
        const result = readExit(exitFile, context.leaseId);
        if (result) notify(result);
      },
      stop: async (): Promise<void> => {
        if (!finished) fs.writeFileSync(stopFile, "", { encoding: "utf8", mode: 0o600 });
      },
    };
  }
}
