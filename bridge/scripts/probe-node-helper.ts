import * as fs from "node:fs";
import * as path from "node:path";
import { NodePtyBackend } from "../src/node-pty-backend";
import type { PtyProcess } from "../src/pty-backend";

let stage = "load";
let proc: PtyProcess | undefined;
let backend: NodePtyBackend | undefined;
let exited = false;

/**
 * 等待真实 PTY 条件。
 * @param predicate 已满足的断言。
 * @param description 当前阶段。
 * @returns 条件满足后完成。
 * @throws {Error} 8 秒内未满足条件。
 */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${description}_TIMEOUT`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 给进程退出增加明确超时。
 * @param promise 退出码 Promise。
 * @param description 当前阶段。
 * @returns 真实退出码。
 */
async function withTimeout(promise: Promise<number>, description: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description}_TIMEOUT`)), 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 检查前五个 tick 的顺序。
 * @param output 累计输出。
 * @returns 是否连续到达 TICK:1 至 TICK:5。
 */
function hasFiveSequentialTicks(output: string): boolean {
  let offset = 0;
  for (let tick = 1; tick <= 5; tick += 1) {
    const index = output.indexOf(`TICK:${tick}`, offset);
    if (index < 0) return false;
    offset = index + `TICK:${tick}`.length;
  }
  return true;
}

/**
 * 通过真实 Node helper 执行完整 PTY 行为探针。
 * @returns 不含环境或密钥的行为结果。
 * @throws {Error} 路径、helper、原生行为或隔离布局不符。
 */
async function main(): Promise<Record<string, unknown>> {
  const nodePath = process.env.PROBE_NODE;
  const helperPath = process.env.PROBE_HELPER;
  const childPath = process.env.PROBE_CHILD;
  const probeCwd = process.env.PROBE_CWD;
  const nativeRoot = process.env.PROBE_NATIVE_ROOT;
  const required = [nodePath, helperPath, childPath, probeCwd, nativeRoot];
  if (required.some((value) => !value || !path.isAbsolute(value))) {
    throw new Error("ABSOLUTE_PROBE_PATHS_REQUIRED");
  }
  const nativeEntry = path.join(nativeRoot!, "lib", "index.js");
  const nativeRelative = path.relative(fs.realpathSync(nativeRoot!), fs.realpathSync(nativeEntry));
  const helperRelative = path.relative(path.dirname(process.execPath), fs.realpathSync(helperPath!));
  const isolatedNative = !nativeRelative.startsWith("..") && !path.isAbsolute(nativeRelative)
    && !helperRelative.startsWith("..") && !path.isAbsolute(helperRelative);

  stage = "spawn-helper";
  backend = new NodePtyBackend({ nodePath: nodePath!, helperPath: helperPath! });
  let output = "";
  let resolveExit: ((exitCode: number) => void) | undefined;
  const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve; });
  proc = await backend.spawn({
    file: nodePath!,
    args: [childPath!],
    cwd: probeCwd!,
    cols: 80,
    rows: 24,
    env: process.env,
  });
  proc.onData((data) => {
    output += data;
    process.stderr.write(data);
  });
  proc.onExit(({ exitCode }) => {
    exited = true;
    resolveExit?.(exitCode);
  });

  stage = "initial-size";
  await waitFor(() => output.includes("SIZE:80x24"), stage);

  stage = "input-chinese-ticks";
  const echoStart = output.length;
  proc.write("ECHO\r");
  await waitFor(() => {
    const received = output.slice(echoStart);
    return received.includes("中文输出:你好") && hasFiveSequentialTicks(output);
  }, stage);

  stage = "resize";
  const resizeStart = output.length;
  proc.resize(132, 36);
  await waitFor(() => output.slice(resizeStart).includes("SIZE:132x36"), stage);

  stage = "exit";
  proc.write("EXIT\r");
  const exitCode = await withTimeout(exitPromise, stage);
  if (exitCode !== 7) throw new Error(`EXIT_CODE_${exitCode}`);

  return {
    behaviors: {
      initialSize: output.includes("SIZE:80x24"),
      inputEcho: output.slice(echoStart).includes("中文输出:你好"),
      continuousTicks: hasFiveSequentialTicks(output),
      chinese: output.slice(echoStart).includes("中文输出:你好"),
      resize: output.slice(resizeStart).includes("SIZE:132x36"),
      exitCode7: exitCode === 7,
    },
    isolatedCwd: path.resolve(process.cwd()) === path.resolve(probeCwd!),
    isolatedNative,
    runtime: process.version,
    helperPid: proc.pid,
  };
}

let probeExitCode = 0;
try {
  const result = await main();
  process.stdout.write(`PTY_PROBE_RESULT:${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stdout.write(`PTY_PROBE_ERROR:${JSON.stringify({ stage, error: message.slice(0, 500) })}\n`);
  probeExitCode = 1;
} finally {
  try {
    if (proc && !exited) await proc.kill();
  } catch {
    // 失败清理继续关闭 helper，不能留下孤立原生进程。
  }
  try {
    await backend?.close();
  } catch {
    // 已断开的 helper 无需重复关闭。
  }
}

process.stdout.write("", () => process.exit(probeExitCode));
