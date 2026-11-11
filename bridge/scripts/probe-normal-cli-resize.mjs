import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * 等待真实 PTY 输出条件。
 * @param {() => boolean} predicate 已满足的条件。
 * @param {string} stage 当前阶段名称。
 * @returns {Promise<void>} 条件满足后完成。
 * @throws {Error} 八秒内未满足时抛出阶段超时。
 */
async function waitFor(predicate, stage) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${stage}_TIMEOUT`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const [nativeEntry, fakeCli, root] = process.argv.slice(2);
if (![nativeEntry, fakeCli, root].every((value) => value && path.isAbsolute(value))) {
  throw new Error("用法: node probe-normal-cli-resize.mjs <node-pty/lib/index.js> <fake-claude.exe> <隔离目录>");
}
const cwd = path.join(root, "cwd");
const config = path.join(root, "config");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(config, { recursive: true });
const nativeRequire = createRequire(path.join(path.dirname(nativeEntry), "..", "package.json"));
const pty = nativeRequire(nativeEntry);

let terminal;
let exited = false;
let exitCode = null;
let output = "";
let resultCode = 1;
try {
  terminal = pty.spawn(fakeCli, ["--resume", "11111111-1111-4111-8111-111111111111"], {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    useConpty: process.platform === "win32",
  });
  terminal.onData((data) => { output += data; });
  terminal.onExit((event) => {
    exited = true;
    exitCode = event.exitCode;
  });
  await waitFor(() => output.includes("ccc-fake>"), "INITIAL_PROMPT");

  // 客户端调用返回不等于子进程已收到通知；先等真实 resize 事件，再查询 /size。
  const resizeStart = output.length;
  terminal.resize(132, 36);
  await waitFor(() => output.slice(resizeStart).includes("RESIZE:132x36"), "RESIZE_EVENT");
  const sizeStart = output.length;
  terminal.write("/size\r");
  await waitFor(() => /SIZE:\d+x\d+/.test(output.slice(sizeStart)), "SIZE_REPORT");
  const match = output.slice(sizeStart).match(/SIZE:(\d+)x(\d+)/);
  const size = { cols: Number(match[1]), rows: Number(match[2]) };
  resultCode = size.cols === 132 && size.rows === 36 ? 0 : 2;

  terminal.write("exit\r");
  await waitFor(() => exited, "EXIT");
  process.stdout.write(`NORMAL_CLI_RESIZE_PROBE:${JSON.stringify({ resizeEvent: true, size, exitCode, remaining: 0 })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`NORMAL_CLI_RESIZE_PROBE_ERROR:${JSON.stringify({ error: message.slice(0, 200) })}\n`);
} finally {
  if (terminal && !exited) {
    try { terminal.kill(); } catch { /* 已退出的原生进程无需重复结束。 */ }
  }
}
// node-pty 的 N-API 句柄可能持有事件循环；清理完成后显式结束一次性探针。
process.stdout.write("", () => process.exit(resultCode));
