import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? "");
const mode = process.argv[3] ?? "bridge";
const method = process.argv[4] ?? "wm-close";
const approved = path.resolve("D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110");
assert(root.startsWith(`${approved}${path.sep}`), "隔离探针目录必须位于已批准的双终端验收根目录");
assert(!fs.existsSync(root), "隔离探针目录必须全新，不能覆盖旧证据");
assert(["bridge", "node", "bun", "csharp"].includes(mode), "探针模式只支持 bridge/node/bun/csharp");
assert(method === "wm-close", "最小探针只保留已验证的 wm-close 正常关闭路径");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(scriptDir, "..", "dist", "ccc-bridge-win-x64");
const tools = path.join(root, "tools");
const home = path.join(root, "home");
const work = path.join(root, "work");
fs.mkdirSync(tools, { recursive: true });
fs.mkdirSync(home);
fs.mkdirSync(work);

/** @param {number} ms 等待毫秒数 @returns {Promise<void>} 延迟完成 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} pid 本轮登记 PID @returns {boolean} 进程是否仍存在 */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 从验收脚本提取同一份 C# 探针，避免两套 Win32 实现产生差异。 @returns {string} C# 源码 */
function windowProbeSource() {
  const source = fs.readFileSync(path.join(scriptDir, "verify-embedded-terminal.mjs"), "utf8");
  const marker = "const WINDOW_PROBE_SOURCE = String.raw`";
  const begin = source.indexOf(marker);
  const nextDeclaration = source.indexOf("const CONSOLE_SHIM_SOURCE", begin);
  const end = source.lastIndexOf("`;", nextDeclaration);
  assert(begin >= 0 && end > begin, "找不到 WindowProbe 源码");
  return source.slice(begin + marker.length, end);
}

const probe = path.join(tools, "WindowProbe.exe");
const sourceFile = path.join(tools, "WindowProbe.cs");
fs.writeFileSync(sourceFile, windowProbeSource(), "utf8");
const compile = spawnSync("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", [
  "/nologo", "/target:exe", `/out:${probe}`, "/reference:System.dll", "/reference:System.Core.dll",
  "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll", sourceFile,
], { cwd: tools, encoding: "utf8", windowsHide: true });
assert(compile.status === 0, `探针编译失败：${compile.stderr || compile.stdout}`);

const terminalExe = path.join(dist, "ccc-terminal.exe");
const readyFile = path.join(work, "ready.txt");
const signalFile = path.join(work, "signal.txt");
const targetScript = path.join(work, "signal-target.cjs");
fs.writeFileSync(targetScript, `const fs = require("fs");
process.on("SIGINT", () => { fs.writeFileSync(process.argv[3], "SIGINT"); process.exit(0); });
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[2], "ready");
`, "utf8");
let targetExe = terminalExe;
let targetArguments = "start";
if (mode === "csharp") {
  targetExe = probe;
  targetArguments = `signal-target "${readyFile}" "${signalFile}"`;
} else if (mode !== "bridge") {
  targetExe = mode === "node" ? process.execPath : spawnSync("where.exe", ["bun"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim();
  assert(targetExe && fs.existsSync(targetExe), `找不到 ${mode} 可执行文件`);
  targetArguments = `"${targetScript}" "${readyFile}" "${signalFile}"`;
}
const child = spawn(probe, ["console-start-wait", targetExe, work, targetArguments], {
  cwd: tools,
  env: { ...process.env, CCC_BRIDGE_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, "claude-config") },
  detached: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "ignore"],
});
let bridgePid = null;
let launcherOutput = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  launcherOutput += chunk;
  if (bridgePid !== null || !launcherOutput.includes("\n")) return;
  const firstLine = launcherOutput.split(/\r?\n/, 1)[0];
  bridgePid = JSON.parse(firstLine).pid;
});
const result = { mode, method, launcherPid: child.pid, sent: false, exited: false, signalReceived: null, error: null };
try {
  const desktop = spawnSync(probe, ["desktop"], { cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert(desktop.status === 0, desktop.stderr || "读取输入桌面失败");
  result.desktop = JSON.parse(desktop.stdout);
  const runtimeFile = path.join(home, "runtime.json");
  const expectedReady = mode === "bridge" ? runtimeFile : readyFile;
  for (let attempt = 0; attempt < 150 && !fs.existsSync(expectedReady); attempt += 1) {
    assert(child.exitCode === null && child.signalCode === null, "隔离目标提前退出");
    await delay(100);
  }
  assert(fs.existsSync(expectedReady), "隔离目标未就绪");
  if (mode === "bridge") bridgePid = JSON.parse(fs.readFileSync(runtimeFile, "utf8")).pid;
  for (let attempt = 0; attempt < 50 && bridgePid === null; attempt += 1) await delay(100);
  assert(Number.isInteger(bridgePid) && bridgePid !== child.pid && bridgePid !== process.pid,
    "控制台启动器未返回独立的目标 PID");
  result.bridgePid = bridgePid;
  const closeArgs = ["console-close", String(bridgePid), String(process.pid)];
  const interrupted = spawnSync(probe, closeArgs, {
    cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  if (interrupted.status !== 0) throw new Error(interrupted.stderr || interrupted.stdout || `探针退出 ${interrupted.status}`);
  const parsed = JSON.parse(interrupted.stdout);
  assert(parsed.sent === true && parsed.isolatedConsole === true, "未确认定向隔离 Console 正常关闭");
  result.sent = true;
  for (let attempt = 0; attempt < 120 && alive(bridgePid); attempt += 1) await delay(100);
  result.exited = !alive(bridgePid);
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt += 1) await delay(100);
  result.exitCode = child.exitCode;
  result.signalCode = child.signalCode;
  result.signalReceived = mode === "bridge" ? null : fs.existsSync(signalFile);
  assert(result.exited, "定向正常关闭后隔离目标未退出");
  if (mode === "bridge") {
    result.runtimeReleased = !fs.existsSync(runtimeFile);
    assert(result.exitCode === 0, `桥接正常关闭退出码异常：${result.exitCode}`);
    assert(result.runtimeReleased, "桥接正常关闭后 runtime.json 仍存在");
  } else {
    assert(result.signalReceived, "目标退出但未记录控制台关闭事件");
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (bridgePid !== null && alive(bridgePid)) process.kill(bridgePid);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt += 1) await delay(100);
  result.bridgePid = bridgePid;
  result.remaining = [child.pid, bridgePid].filter((pid) => pid !== null && alive(pid));
  fs.writeFileSync(path.join(root, mode === "bridge" ? "console-interrupt.json" : `signal-${mode}.json`), JSON.stringify(result, null, 2), "utf8");
}
console.log(JSON.stringify(result));
