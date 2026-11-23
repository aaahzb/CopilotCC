import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { localApprovedVerificationRoot } from "./verification-root.mjs";
import { assertGracefulShutdownLog, assertNoFakeSigbreak } from "../../scripts/shutdown-diagnostics.mjs";

const root = path.resolve(process.argv[2] ?? "");
const mode = process.argv[3] ?? "bridge";
const method = process.argv[4] ?? "wm-close";
const scenario = process.argv[5] ?? "idle";
const approved = localApprovedVerificationRoot();
assert(root.startsWith(`${approved}${path.sep}`), "隔离探针目录必须位于已批准的双终端验收根目录");
assert(!fs.existsSync(root), "隔离探针目录必须全新，不能覆盖旧证据");
assert(["bridge", "node", "bun", "csharp"].includes(mode), "探针模式只支持 bridge/node/bun/csharp");
assert(["wm-close", "ctrl-break-group"].includes(method), "探针关闭方式只支持 wm-close/ctrl-break-group");
assert(["idle", "sdk-child"].includes(scenario), "探针场景只支持 idle/sdk-child");
assert(scenario === "idle" || mode === "bridge", "sdk-child 场景只支持真实桥接");
const fakeCli = process.env.CCC_PROBE_FAKE_CLI;
if (scenario === "sdk-child") {
  assert(fakeCli && path.isAbsolute(fakeCli) && fs.existsSync(fakeCli),
    "sdk-child 场景需要 CCC_PROBE_FAKE_CLI 指向隔离假 CLI");
}
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

/** @param {string} executable 可执行路径 @returns 用于 Windows 身份比较的规范路径 */
function normalizeExecutable(executable) {
  return path.resolve(executable).replace(/\\/g, "/").toLowerCase();
}

/** @param {number} pid 待核对 PID @returns 同一原生句柄读取的路径与精确启动时间；进程不存在返回 null */
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const queried = spawnSync(probe, ["process-identity", String(pid)], {
    cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  if (queried.error) throw queried.error;
  assert(queried.status === 0, `进程 ${pid} 身份查询失败：${queried.stderr || queried.stdout}`);
  const identity = JSON.parse(queried.stdout);
  if (identity === null) return null;
  assert(identity.pid === pid && identity.executable && Number.isFinite(Date.parse(identity.startedAt))
    && /^\d+$/.test(identity.startedTicks), `进程 ${pid} 身份查询结果不完整`);
  return identity;
}

const processRegistrations = new Map();

/** 登记本轮独占进程；路径不符时拒绝把它纳入任何后续清理。 */
function registerProcess(pid, executable) {
  const identity = processIdentity(pid);
  assert(identity, `无法读取本轮进程 ${pid} 的完整身份`);
  assert(normalizeExecutable(identity.executable) === normalizeExecutable(executable),
    `进程 ${pid} 可执行路径不符：${identity.executable} != ${executable}`);
  processRegistrations.set(pid, identity);
  return identity;
}

/** 身份不符的复用 PID 仍记为 remaining，但 registeredAlive 不会把它当成本轮进程。 */
function registeredProcessState(pid) {
  const expected = processRegistrations.get(pid);
  assert(expected, `进程 ${pid} 尚未登记完整身份`);
  const actual = processIdentity(pid);
  const identityMatches = actual !== null
    && normalizeExecutable(actual.executable) === normalizeExecutable(expected.executable)
    && actual.startedTicks === expected.startedTicks;
  return { pid, exists: actual !== null, identityMatches: actual === null ? null : identityMatches, expected, actual };
}

function registeredAlive(pid) {
  const state = registeredProcessState(pid);
  return state.exists && state.identityMatches === true;
}

/** 由 helper 在同一操作系统句柄上复核完整身份并执行异常终止。 */
function killRegistered(pid) {
  const state = registeredProcessState(pid);
  if (!state.exists) return false;
  assert(state.identityMatches === true, `拒绝终止身份不符的 PID ${pid}`);
  const terminated = spawnSync(probe, ["process-kill", String(pid), state.expected.executable, state.expected.startedTicks], {
    cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  assert(terminated.status === 0, `句柄绑定终止失败：${terminated.stderr || terminated.stdout}`);
  const parsed = JSON.parse(terminated.stdout);
  assert(parsed.sent === true && parsed.identityBound === true && parsed.pid === pid,
    `未确认句柄绑定终止：${terminated.stdout}`);
  return true;
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
process.on("SIGBREAK", () => { fs.writeFileSync(process.argv[3], "SIGBREAK"); process.exit(0); });
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[2], "ready");
`, "utf8");
let targetExe = terminalExe;
let targetArguments = "start";
if (mode === "csharp") {
  targetExe = probe;
  targetArguments = `signal-target "${readyFile}" "${signalFile}"`;
} else if (mode !== "bridge") {
  if (mode === "node") targetExe = process.execPath;
  else {
    const launchers = spawnSync("where.exe", ["bun"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    targetExe = launchers.find((file) => path.extname(file).toLowerCase() === ".exe" && fs.existsSync(file))
      ?? launchers.map((file) => path.join(path.dirname(file), "node_modules", "bun", "bin", "bun.exe"))
        .find((file) => fs.existsSync(file)) ?? "";
  }
  assert(targetExe && fs.existsSync(targetExe), `找不到 ${mode} 可执行文件`);
  targetArguments = `"${targetScript}" "${readyFile}" "${signalFile}"`;
}
const child = spawn(probe, ["console-start-wait", targetExe, work, targetArguments], {
  cwd: tools,
  env: {
    ...process.env,
    CCC_BRIDGE_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
    ...(scenario === "sdk-child" ? {
      CLAUDE_CODE_PATH: fakeCli,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      ANTHROPIC_API_KEY: "mock-local-only",
      ANTHROPIC_AUTH_TOKEN: "mock-local-only",
      NO_PROXY: "127.0.0.1,localhost",
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
      CCC_FAKE_CLI_DELAY_STREAM_INIT_MS: "0",
      CCC_FAKE_CLI_IGNORE_SIGBREAK: "1",
    } : {}),
  },
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

/** @param {() => unknown} condition 条件 @param {string} label 等待目标 @returns {Promise<unknown>} 条件真值 */
async function waitFor(condition, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

/** 通过真实 WS 驱动隔离 SDK 子进程完成一轮聊天，保留子进程后测试同 Console 正常关闭。 */
async function completeSdkChat() {
  const runtime = JSON.parse(fs.readFileSync(path.join(home, "runtime.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws?token=${encodeURIComponent(config.token)}`);
  control = socket;
  const inbox = [];
  socket.on("message", (data) => inbox.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "client.ready" }));
  socket.send(JSON.stringify({ type: "folder.bind", path: work, reset: true }));
  await waitFor(() => inbox.some((message) => message.type === "folder.bound" && message.path === work),
    "隔离 SDK 文件夹绑定");
  const eventLog = path.join(root, "claude-config", "fake-cli-events.jsonl");
  const event = await waitFor(() => {
    if (!fs.existsSync(eventLog)) return null;
    return fs.readFileSync(eventLog, "utf8").split(/\r?\n/)
      .filter(Boolean).map((line) => JSON.parse(line))
      .filter((item) => item.kind === "start").at(-1);
  }, "隔离 SDK 子进程身份");
  sdkChildPid = event.pid;
  result.sdkChildPid = sdkChildPid;
  result.sdkChildIdentity = registerProcess(sdkChildPid, fakeCli);
  socket.send(JSON.stringify({ type: "chat.send", text: "NATIVE_FAILURE_CHAT_ACCEPTED" }));
  await waitFor(() => inbox.some((message) => message.type === "chat.done"), "隔离 SDK 聊天完成");
  socket.close();
}

let sdkChildPid = null;
let control = null;
let shutdownDiagnosticOffset = 0;
const result = {
  mode, method, scenario, launcherPid: child.pid, sent: false, exited: false, signalReceived: null,
  identityMismatchCloseRejected: false, identityMismatchKillRejected: false,
  error: null, cleanupErrors: [],
};
try {
  registerProcess(child.pid, probe);
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
  result.bridgeIdentity = registerProcess(bridgePid, targetExe);
  if (scenario === "sdk-child") await completeSdkChat();
  if (mode === "bridge") {
    const diagnosticFile = path.join(home, "startup-diag.log");
    shutdownDiagnosticOffset = fs.existsSync(diagnosticFile) ? fs.statSync(diagnosticFile).size : 0;
  }
  const closeCommand = method === "ctrl-break-group" ? "console-break-group" : "console-close";
  const expectedMethod = method === "ctrl-break-group" ? "CTRL_BREAK_EVENT" : "WM_CLOSE";
  const expectedIdentity = processRegistrations.get(bridgePid);
  assert(expectedIdentity, "关闭前缺少桥接登记身份");
  const closeArgs = [closeCommand, String(bridgePid), String(process.pid),
    expectedIdentity.executable, expectedIdentity.startedTicks];
  const wrongTicks = (BigInt(expectedIdentity.startedTicks) + 1n).toString();
  const wrongClose = spawnSync(probe, [closeCommand, String(bridgePid), String(process.pid),
    expectedIdentity.executable, wrongTicks], { cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000 });
  await delay(100);
  result.identityMismatchCloseRejected = wrongClose.status !== 0
    && String(wrongClose.stderr).includes("owned process start time mismatch") && registeredAlive(bridgePid);
  assert(result.identityMismatchCloseRejected, "错误启动时间的 Console 信号负控未被安全拒绝");
  const wrongKill = spawnSync(probe, ["process-kill", String(bridgePid), expectedIdentity.executable, wrongTicks], {
    cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  await delay(100);
  result.identityMismatchKillRejected = wrongKill.status !== 0
    && String(wrongKill.stderr).includes("owned process start time mismatch") && registeredAlive(bridgePid);
  assert(result.identityMismatchKillRejected, "错误启动时间的终止负控未被安全拒绝");
  const interrupted = spawnSync(probe, closeArgs, {
    cwd: tools, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  if (interrupted.status !== 0) throw new Error(interrupted.stderr || interrupted.stdout || `探针退出 ${interrupted.status}`);
  const parsed = JSON.parse(interrupted.stdout);
  assert(parsed.sent === true && parsed.isolatedConsole === true && parsed.consolePid === bridgePid
    && parsed.identityBound === true && parsed.method === expectedMethod, `未确认定向隔离 Console 关闭方法：${interrupted.stdout}`);
  result.closeMethod = parsed.method;
  result.sent = true;
  for (let attempt = 0; attempt < 120 && registeredAlive(bridgePid); attempt += 1) await delay(100);
  result.exited = !registeredAlive(bridgePid);
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt += 1) await delay(100);
  result.exitCode = child.exitCode;
  result.signalCode = child.signalCode;
  assert(result.exited, "定向正常关闭后隔离目标未退出");
  if (mode === "bridge") {
    result.runtimeReleased = !fs.existsSync(runtimeFile);
    assert(result.exitCode === 0, `桥接正常关闭退出码异常：${result.exitCode}`);
    assert(result.runtimeReleased, "桥接正常关闭后 runtime.json 仍存在");
    const diagnosticFile = path.join(home, "startup-diag.log");
    const diagnostics = fs.readFileSync(diagnosticFile);
    if (method === "ctrl-break-group") {
      result.shutdownStages = assertGracefulShutdownLog(diagnostics.subarray(shutdownDiagnosticOffset).toString("utf8"));
    }
  } else {
    result.signalReceived = fs.existsSync(signalFile) ? fs.readFileSync(signalFile, "utf8").trim() : null;
    assert(result.signalReceived, "目标退出但未记录控制台关闭事件");
    if (method === "ctrl-break-group") {
      const expectedSignal = mode === "csharp" ? "CTRL:1" : "SIGBREAK";
      assert(result.signalReceived === expectedSignal,
        `目标实际信号不符：${result.signalReceived} != ${expectedSignal}`);
    }
  }
  if (sdkChildPid !== null) {
    for (let attempt = 0; attempt < 50 && registeredAlive(sdkChildPid); attempt += 1) await delay(100);
    result.sdkChildExited = !registeredAlive(sdkChildPid);
    assert(result.sdkChildExited, "桥接正常关闭后隔离 SDK 子进程仍存活");
    const events = fs.readFileSync(path.join(root, "claude-config", "fake-cli-events.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    result.sdkChildSigbreakHandlerArmed = events.some((event) => event.kind === "signal-handler"
      && event.pid === sdkChildPid && event.signal === "SIGBREAK");
    result.sdkChildSigbreakReceived = events.some((event) => event.kind === "signal"
      && event.pid === sdkChildPid && event.signal === "SIGBREAK");
    if (method === "ctrl-break-group") {
      assertNoFakeSigbreak(events);
      assert(result.sdkChildSigbreakHandlerArmed,
        "假 CLI 未安装 SIGBREAK 忽略处理器，不能排除进程组信号直接终止造成假通过");
    }
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (control && control.readyState !== WebSocket.CLOSED) control.terminate();
  for (const pid of [bridgePid, sdkChildPid]) {
    if (pid === null || !processRegistrations.has(pid)) continue;
    try {
      if (killRegistered(pid)) {
        for (let attempt = 0; attempt < 30 && registeredAlive(pid); attempt += 1) await delay(100);
      }
    } catch (error) {
      result.cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt += 1) await delay(100);
  result.bridgePid = bridgePid;
  result.processStates = [];
  for (const pid of [bridgePid, sdkChildPid]) {
    if (pid === null || !processRegistrations.has(pid)) continue;
    try { result.processStates.push(registeredProcessState(pid)); } catch (error) {
      result.processStates.push({ pid, exists: true, identityMatches: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.launcherExited = child.exitCode !== null || child.signalCode !== null;
  result.remaining = [...new Set([
    ...result.processStates.filter((state) => state.exists).map((state) => state.pid),
    ...(result.launcherExited ? [] : [child.pid]),
  ])];
  const cleanupFailure = result.remaining.length > 0 || result.cleanupErrors.length > 0
    ? `清理未完成：remaining=${JSON.stringify(result.remaining)} errors=${JSON.stringify(result.cleanupErrors)}` : null;
  const throwCleanupFailure = result.error === null && cleanupFailure !== null;
  if (throwCleanupFailure) result.error = cleanupFailure;
  fs.writeFileSync(path.join(root, mode === "bridge" ? "console-interrupt.json" : `signal-${mode}.json`), JSON.stringify(result, null, 2), "utf8");
  if (throwCleanupFailure) throw new Error(cleanupFailure);
}
console.log(JSON.stringify(result));
