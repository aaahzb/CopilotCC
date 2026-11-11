import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmbeddedBackend } from "./embedded-terminal";
import type { PtyBackend, PtyProcess } from "./pty-backend";

/** 显式 --pty-smoke 的依赖；正常运行路径不会调用此接口。 */
export interface PtySmokeOptions {
  expectedPlatform: string;
  expectedArch: string;
  cliPath: string;
  executableDir: string;
  backend?: PtyBackend;
}

/** 只含行为断言的公开结果，不含命令环境、token 或终端正文。 */
export interface PtySmokeResult {
  initialSize: boolean;
  inputEcho: boolean;
  continuousTicks: boolean;
  chinese: boolean;
  resize: boolean;
  exitCode7: boolean;
  backend: PtyBackend["kind"];
}

/** @param predicate 已满足的行为条件 @param stage 当前阶段 @returns 条件满足后的 Promise */
async function waitFor(predicate: () => boolean, stage: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`PTY_SMOKE_${stage}_TIMEOUT`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** @param output 累计输出 @returns 是否按顺序收到至少五个 tick */
function hasFiveTicks(output: string): boolean {
  let offset = 0;
  for (let tick = 1; tick <= 5; tick += 1) {
    const index = output.indexOf(`TICK:${tick}`, offset);
    if (index < 0) return false;
    offset = index + `TICK:${tick}`.length;
  }
  return true;
}

/**
 * 在隔离目录中执行真实 PTY 行为探针，并始终结束后端。
 * @param options 平台、架构、隔离假 CLI 和已实测后端目录
 * @returns 初始尺寸、中文、连续输出、resize 和退出码结果
 * @throws 平台不符、命令非绝对路径、行为超时或退出码非 7
 */
export async function runPtySmoke(options: PtySmokeOptions): Promise<PtySmokeResult> {
  if (process.platform !== options.expectedPlatform || process.arch !== options.expectedArch) {
    throw new Error("PTY_SMOKE_PLATFORM_MISMATCH");
  }
  if (!options.cliPath || !path.isAbsolute(options.cliPath)) throw new Error("PTY_SMOKE_CLI_REQUIRED");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-pty-smoke-"));
  const cwd = path.join(root, "cwd");
  const config = path.join(root, "claude-config");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const backend = options.backend ?? createEmbeddedBackend(options.executableDir);
  let pty: PtyProcess | undefined;
  let exited = false;
  try {
    pty = await backend.spawn({
      file: options.cliPath,
      args: [],
      cwd,
      cols: 80,
      rows: 24,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: config,
        CCC_PTY_SMOKE_MODE: "1",
      },
    });
    let output = "";
    let exitCode: number | null = null;
    pty.onData((data) => { output += data; });
    pty.onExit((event) => {
      exitCode = event.exitCode;
      exited = true;
    });

    await waitFor(() => output.includes("SIZE:80x24"), "INITIAL_SIZE");
    const echoStart = output.length;
    pty.write("ECHO\r");
    await waitFor(() => output.slice(echoStart).includes("中文输出:你好") && hasFiveTicks(output), "INPUT");
    const resizeStart = output.length;
    pty.resize(132, 36);
    await waitFor(() => output.slice(resizeStart).includes("SIZE:132x36"), "RESIZE");
    pty.write("EXIT\r");
    await waitFor(() => exitCode !== null, "EXIT");
    if (exitCode !== 7) throw new Error(`PTY_SMOKE_EXIT_${exitCode}`);

    return {
      initialSize: output.includes("SIZE:80x24"),
      inputEcho: output.slice(echoStart).includes("中文输出:你好"),
      continuousTicks: hasFiveTicks(output),
      chinese: output.slice(echoStart).includes("中文输出:你好"),
      resize: output.slice(resizeStart).includes("SIZE:132x36"),
      exitCode7: exitCode === 7,
      backend: backend.kind,
    };
  } finally {
    if (pty && !exited) {
      try { await pty.kill(); } catch { /* 随后仍关闭整个后端。 */ }
    }
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
