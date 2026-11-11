import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readProcessIdentity } from "./process-identity";
import { UUID_RE } from "./protocol";
import type { ProcessIdentity } from "./terminal-lease";

export interface TerminalChildRequest {
  leaseId: string;
  cwd: string;
  cliPath: string;
  args: string[];
  exitFile: string;
  stopFile: string;
  hookUrl?: string;
  hookTokenFile?: string;
}

export interface TerminalChildDeps {
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  identity?: (pid: number) => Promise<ProcessIdentity | null>;
}

/** @param value 不可信 JSON 值 @returns 只含字符串键的record，否则null */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** @param file 待核对的私有文件 @param directory 请求所在目录 @param name 精确文件名 @returns 路径是否匹配 */
function privateFile(file: unknown, directory: string, name: string): file is string {
  return typeof file === "string" && path.resolve(file) === path.join(directory, name);
}

/**
 * 严格收窄包装进程请求；退出、停止和 token 文件均不得越出请求目录。
 * @param input 请求 JSON
 * @param requestFile 请求文件绝对路径
 * @returns 经过校验的非敏感启动请求
 * @throws 任何字段、UUID、路径或参数非法时抛出 TERMINAL_CHILD_REQUEST
 */
export function parseTerminalChildRequest(input: unknown, requestFile: string): TerminalChildRequest {
  const value = recordOf(input);
  const directory = path.dirname(path.resolve(requestFile));
  if (!value || typeof value.leaseId !== "string" || !UUID_RE.test(value.leaseId)
    || path.basename(requestFile) !== `${value.leaseId}.request.json`
    || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)
    || typeof value.cliPath !== "string" || !path.isAbsolute(value.cliPath)
    || !Array.isArray(value.args) || value.args.length > 32
    || !value.args.every((arg) => typeof arg === "string" && arg.length <= 32_768)
    || !privateFile(value.exitFile, directory, `${value.leaseId}.exit.json`)
    || !privateFile(value.stopFile, directory, `${value.leaseId}.stop`)) {
    throw new Error("TERMINAL_CHILD_REQUEST");
  }
  if (value.hookUrl !== undefined && (typeof value.hookUrl !== "string"
    || !/^http:\/\/127\.0\.0\.1:\d+\/terminal-hook\/[0-9a-f-]+$/.test(value.hookUrl))) {
    throw new Error("TERMINAL_CHILD_REQUEST");
  }
  if (value.hookTokenFile !== undefined
    && !privateFile(value.hookTokenFile, directory, `${value.leaseId}.hook-token`)) {
    throw new Error("TERMINAL_CHILD_REQUEST");
  }
  if ((value.hookUrl === undefined) !== (value.hookTokenFile === undefined)) {
    throw new Error("TERMINAL_CHILD_REQUEST");
  }
  return {
    leaseId: value.leaseId,
    cwd: value.cwd,
    cliPath: value.cliPath,
    args: [...value.args] as string[],
    exitFile: value.exitFile,
    stopFile: value.stopFile,
    ...(typeof value.hookUrl === "string" ? { hookUrl: value.hookUrl } : {}),
    ...(typeof value.hookTokenFile === "string" ? { hookTokenFile: value.hookTokenFile } : {}),
  };
}

/**
 * 私有包装进程：记录自身身份，继承桥接环境启动真实 CLI，并以文件报告真实退出。
 * @param requestFile 仅由系统启动器生成的私有请求文件
 * @param deps 测试可注入进程与身份查询
 * @returns CLI 退出后的 Promise；正常退出码为0，其他情况设置非零退出码
 * @throws 请求非法、身份不可确认或 CLI 无法启动时抛固定错误
 */
export async function runTerminalChild(
  requestFile: string,
  deps: TerminalChildDeps = {},
): Promise<void> {
  const absoluteRequest = path.resolve(requestFile);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(absoluteRequest, "utf8"));
  } catch {
    throw new Error("TERMINAL_CHILD_REQUEST");
  }
  const request = parseTerminalChildRequest(raw, absoluteRequest);
  const directory = path.dirname(absoluteRequest);
  const identity = await (deps.identity ?? readProcessIdentity)(process.pid);
  if (!identity || identity.pid !== process.pid && !deps.identity) {
    throw new Error("TERMINAL_CHILD_IDENTITY");
  }
  fs.writeFileSync(path.join(directory, `${request.leaseId}.status.json`), JSON.stringify({
    leaseId: request.leaseId,
    pid: identity.pid,
    executable: identity.executable,
    startedAt: identity.startedAt,
  }), { encoding: "utf8", mode: 0o600 });

  // 桥接确认 lease 后才写 .start；取消、停止或桥接消失都不得产生失控 CLI。
  const startFile = path.join(directory, `${request.leaseId}.start`);
  const cancelFile = path.join(directory, `${request.leaseId}.cancel`);
  const startDeadline = Date.now() + 20_000;
  while (!fs.existsSync(startFile)) {
    if (fs.existsSync(cancelFile) || fs.existsSync(request.stopFile)) return;
    if (Date.now() >= startDeadline) throw new Error("TERMINAL_CHILD_START_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  // token 只在包装进程内从私有文件进入子进程环境，不出现在请求或可见命令行。
  const hookToken = request.hookTokenFile
    ? fs.readFileSync(request.hookTokenFile, "utf8")
    : null;
  const childEnv = hookToken && request.hookUrl
    ? { ...process.env, CCC_TERMINAL_HOOK_URL: request.hookUrl, CCC_TERMINAL_HOOK_TOKEN: hookToken }
    : process.env;
  const spawnImpl = deps.spawn ?? spawn;
  // start 到达后仍可能在读取 token 时发生 cancel/stop，spawn 前必须再次核对。
  if (fs.existsSync(cancelFile) || fs.existsSync(request.stopFile) || !fs.existsSync(startFile)) return;
  let child: ChildProcess;
  try {
    child = spawnImpl(request.cliPath, request.args, {
      cwd: request.cwd,
      env: childEnv,
      stdio: "inherit",
      windowsHide: false,
    });
  } catch {
    throw new Error("TERMINAL_CHILD_SPAWN");
  }

  await new Promise<void>((resolve, reject) => {
    const stopTimer = setInterval(() => {
      if (fs.existsSync(request.stopFile)) child.kill();
    }, 250);
    stopTimer.unref();
    child.once("error", () => {
      clearInterval(stopTimer);
      reject(new Error("TERMINAL_CHILD_SPAWN"));
    });
    child.once("exit", (exitCode, signal) => {
      clearInterval(stopTimer);
      fs.writeFileSync(request.exitFile, JSON.stringify({
        leaseId: request.leaseId,
        exitCode,
        reason: signal ?? "exit",
      }), { encoding: "utf8", mode: 0o600 });
      if (exitCode !== 0 && exitCode !== null) process.exitCode = exitCode;
      resolve();
    });
  });
}
