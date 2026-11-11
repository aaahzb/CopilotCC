import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IPty } from "node-pty";

interface ProbeBehaviors {
  initialSize: boolean;
  inputEcho: boolean;
  continuousTicks: boolean;
  chinese: boolean;
  resize: boolean;
  exitCode7: boolean;
}

interface ProbeResult {
  behaviors: ProbeBehaviors;
  isolatedCwd: boolean;
  isolatedNative: boolean;
  runtime: string;
}

let stage = "load";
let term: IPty | undefined;
let exited = false;

/**
 * 等待真实 PTY 条件，超时后保留当前阶段。
 * @param predicate 已满足的断言。
 * @param description 超时阶段名称。
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
 * 给退出事件设置独立超时，避免探针永久挂起。
 * @param promise 待等待的退出码。
 * @param description 超时阶段名称。
 * @returns 真实进程退出码。
 * @throws {Error} 8 秒内未退出。
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
 * 验证前五个 tick 均按顺序到达，而非只匹配最后一个编号。
 * @param output 累计终端输出。
 * @returns 是否收到连续五个 tick。
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
 * 从编译 exe 旁的外置包执行完整 PTY 行为探针。
 * @returns 不含环境或密钥的行为结果。
 * @throws {Error} 原生加载、输入输出、中文、resize 或退出码不符。
 */
async function main(): Promise<ProbeResult> {
  const nodePath = process.env.PROBE_NODE;
  const childPath = process.env.PROBE_CHILD;
  const probeCwd = process.env.PROBE_CWD;
  if (!nodePath || !childPath || !probeCwd || ![nodePath, childPath, probeCwd].every(path.isAbsolute)) {
    throw new Error("ABSOLUTE_PROBE_PATHS_REQUIRED");
  }

  const executableDir = path.dirname(process.execPath);
  const requireBase = path.join(executableDir, "pty", "package.json");
  const externalRequire = createRequire(requireBase);
  // Bun 1.4.3 编译态不能由合成 package.json 按名称搜索外置 node_modules；
  // 直接传入隔离包的绝对入口，仍由真实 createRequire 在进程外文件系统加载。
  const nativeRoot = path.join(executableDir, "pty", "node_modules", "node-pty");
  const nativeEntry = path.join(nativeRoot, "lib", "index.js");
  const pty = externalRequire(nativeEntry) as typeof import("node-pty");
  const nativeRelative = path.relative(fs.realpathSync(nativeRoot), fs.realpathSync(nativeEntry));
  const isolatedNative = !nativeRelative.startsWith("..") && !path.isAbsolute(nativeRelative);

  stage = "spawn";
  let output = "";
  let resolveExit: ((exitCode: number) => void) | undefined;
  const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve; });
  term = pty.spawn(nodePath, [childPath], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: probeCwd,
    env: process.env,
    useConpty: true,
  });
  term.onData((data: string) => {
    output += data;
    process.stderr.write(data);
  });
  term.onExit(({ exitCode }: { exitCode: number }) => {
    exited = true;
    resolveExit?.(exitCode);
  });

  stage = "initial-size";
  await waitFor(() => output.includes("SIZE:80x24"), stage);

  stage = "input-chinese-ticks";
  const echoStart = output.length;
  term.write("ECHO\r");
  await waitFor(() => {
    const received = output.slice(echoStart);
    return received.includes("中文输出:你好") && hasFiveSequentialTicks(output);
  }, stage);

  stage = "resize";
  const resizeStart = output.length;
  term.resize(132, 36);
  await waitFor(() => output.slice(resizeStart).includes("SIZE:132x36"), stage);

  stage = "exit";
  term.write("EXIT\r");
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
    isolatedCwd: path.resolve(process.cwd()) === path.resolve(probeCwd),
    isolatedNative,
    runtime: process.version,
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
  if (term && !exited) {
    try {
      term.kill();
    } catch {
      // 进程已在断言失败与清理之间退出时无需重复终止。
    }
  }
}

// node-pty 的 N-API 句柄可让 Bun 在子进程退出后继续保持事件循环；一次性探针 flush 后显式结束。
process.stdout.write("", () => process.exit(probeExitCode));
