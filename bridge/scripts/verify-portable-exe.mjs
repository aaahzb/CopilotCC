/** Windows 绿色单文件真实生命周期验收；仅在批准根目录的新空子目录运行。 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPayloadManifest } from "./build-portable-exe.mjs";
import { resolvePortableVerificationRoot } from "./portable-verification-root.mjs";

const APPROVED_ROOT = "D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORTABLE_EXE = path.join(PROJECT_ROOT, "bridge", "dist", "portable-win-x64", "CopilotCC.exe");
const FULL_DIST = path.join(PROJECT_ROOT, "bridge", "dist", "ccc-bridge-win-x64");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param condition 实际条件 @param message 失败说明 @returns 条件为真时无返回值 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param parent 父目录 @param child 子路径 @returns child 是否严格位于 parent 内 */
function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** @param value 文件内容 @returns SHA-256 */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const rootIndex = process.argv.indexOf("--root");
const root = resolvePortableVerificationRoot(
  rootIndex >= 0 ? process.argv[rootIndex + 1] : "",
  {
    localApprovedRoot: APPROVED_ROOT,
    runnerTemp: process.env.RUNNER_TEMP ?? "",
    projectRoot: PROJECT_ROOT,
    githubActions: process.env.GITHUB_ACTIONS === "true",
  },
);
assert(process.platform === "win32", "本验收仅支持 Windows");
if (fs.existsSync(root)) assert(fs.readdirSync(root).length === 0, "root 必须为空，不覆盖旧证据");
const appDir = path.join(root, "app");
const home = path.join(root, "home");
const cwd = path.join(root, "cwd");
const tools = path.join(root, "tools");
const claudeConfig = path.join(root, "claude-config");
for (const directory of [root, appDir, home, cwd, tools, claudeConfig]) fs.mkdirSync(directory, { recursive: true });
process.chdir(cwd);
assert(!inside(PROJECT_ROOT, process.cwd()) && process.cwd() !== PROJECT_ROOT, "CWD 不得位于项目树内");
assert(fs.existsSync(PORTABLE_EXE), "缺少真实 CopilotCC.exe");
const appExe = path.join(appDir, "CopilotCC.exe");
fs.copyFileSync(PORTABLE_EXE, appExe, fs.constants.COPYFILE_EXCL);
const expectedHash = createPayloadManifest(FULL_DIST).payloadHash;
const resultFile = path.join(root, "portable-verification.json");
const evidence = {
  portableSingleFileOnly: false,
  startupProgressVisible: false,
  cleanupBeforeExtract: false,
  oldVersionRemoved: false,
  unknownPreserved: false,
  activePreserved: false,
  staleStagingRemoved: false,
  tamperedRebuilt: false,
  repeatedStartsBounded: false,
  noSidecarFiles: false,
  cleanupEmpty: false,
  guiSubsystem: false,
  junctionPreserved: false,
  foreignProductPreserved: false,
  currentHashMatchesBuild: false,
  realApiCalled: false,
  macOSVerified: false,
  observations: {
    sourceBytes: fs.statSync(PORTABLE_EXE).size,
    sourceSha256: hash(fs.readFileSync(PORTABLE_EXE)),
    copiedSha256: hash(fs.readFileSync(appExe)),
    payloadHash: expectedHash,
    startupEvents: [],
    cleanup: { remaining: [], errors: [] },
  },
  ok: false,
};

const PROBE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class PortableProbe {
  public class WindowInfo { public string handle, title, className; public int pid; public bool visible; public int left, top, width, height; }
  public class ProcessInfo { public int pid; public string executable; public string startTicks; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  private delegate bool EnumCallback(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr extra);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

  private static List<WindowInfo> Windows(int wanted) {
    var result = new List<WindowInfo>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr extra) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (wanted > 0 && pid != wanted) return true;
      var title = new StringBuilder(512); GetWindowText(hwnd, title, title.Capacity);
      var className = new StringBuilder(256); GetClassName(hwnd, className, className.Capacity);
      RECT rect; GetWindowRect(hwnd, out rect);
      result.Add(new WindowInfo {
        handle = "0x" + hwnd.ToInt64().ToString("x"), title = title.ToString(), className = className.ToString(),
        pid = (int)pid, visible = IsWindowVisible(hwnd), left = rect.Left, top = rect.Top,
        width = rect.Right - rect.Left, height = rect.Bottom - rect.Top,
      });
      return true;
    }, IntPtr.Zero);
    return result;
  }

  private static string FullPath(Process process) {
    return Path.GetFullPath(process.MainModule.FileName);
  }

  public static int Main(string[] args) {
    try {
      Console.OutputEncoding = Encoding.UTF8;
      var json = new JavaScriptSerializer();
      if (args.Length == 2 && args[0] == "windows") {
        Console.Write(json.Serialize(Windows(Int32.Parse(args[1])))); return 0;
      }
      if (args.Length == 1 && args[0] == "processes") {
        var result = new List<ProcessInfo>();
        foreach (Process process in Process.GetProcesses()) using (process) {
          try {
            result.Add(new ProcessInfo { pid = process.Id, executable = FullPath(process), startTicks = process.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture) });
          } catch { }
        }
        Console.Write(json.Serialize(result)); return 0;
      }
      if (args.Length == 4 && args[0] == "kill") {
        int pid = Int32.Parse(args[1]);
        using (Process process = Process.GetProcessById(pid)) {
          if (!String.Equals(FullPath(process), Path.GetFullPath(args[2]), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("process path mismatch");
          if (process.StartTime.ToUniversalTime().Ticks != Int64.Parse(args[3])) throw new InvalidOperationException("process start mismatch");
          process.Kill(); process.WaitForExit(10000);
          Console.Write("{\"killed\":true}"); return 0;
        }
      }
      if (args.Length == 4 && args[0] == "watch") {
        int pid = Int32.Parse(args[1]);
        bool seen = false, captured = false;
        string seenClass = "";
        int seenWidth = 0, seenHeight = 0;
        for (int elapsed = 0; elapsed < 120000; elapsed += 10) {
          foreach (WindowInfo window in Windows(pid)) {
            if (!window.visible || window.width < 300 || window.height < 100
              || window.title.IndexOf("CopilotCC 正在启动") < 0) continue;
            seen = true; seenClass = window.className; seenWidth = window.width; seenHeight = window.height;
            IntPtr hwnd = new IntPtr(Int64.Parse(window.handle.Substring(2), System.Globalization.NumberStyles.HexNumber));
            using (var bitmap = new Bitmap(window.width, window.height))
            using (var graphics = Graphics.FromImage(bitmap)) {
              IntPtr hdc = graphics.GetHdc();
              captured = PrintWindow(hwnd, hdc, 2);
              graphics.ReleaseHdc(hdc);
              // PrintWindow 在 WinForms 首次绘制前也可能成功并返回全黑客户区；亮背景尚未出现就继续等真实绘制。
              bool clientPainted = false;
              for (int y = window.height / 2; y < window.height && !clientPainted; y += 4) {
                for (int x = 0; x < window.width; x += 4) {
                  Color pixel = bitmap.GetPixel(x, y);
                  if (pixel.R > 150 && pixel.G > 150 && pixel.B > 150) { clientPainted = true; break; }
                }
              }
              captured = captured && clientPainted;
              if (captured) bitmap.Save(args[2], ImageFormat.Png);
            }
            if (captured) {
              var found = new { seen = true, captured = true, className = seenClass, width = seenWidth, height = seenHeight };
              File.WriteAllText(args[3], json.Serialize(found)); Console.Write(json.Serialize(found)); return 0;
            }
          }
          try { using (Process process = Process.GetProcessById(pid)) if (process.HasExited) break; }
          catch (ArgumentException) { break; }
          Thread.Sleep(10);
        }
        var payload = new { seen, captured = false, className = seenClass, width = seenWidth, height = seenHeight };
        File.WriteAllText(args[3], json.Serialize(payload)); Console.Write(json.Serialize(payload)); return seen ? 3 : 2;
      }
      if (args.Length == 3 && args[0] == "capture") {
        foreach (WindowInfo window in Windows(Int32.Parse(args[1]))) {
          if (!window.visible || window.width < 100 || window.height < 60 || window.title.IndexOf("CopilotCC") < 0) continue;
          IntPtr hwnd = new IntPtr(Int64.Parse(window.handle.Substring(2), System.Globalization.NumberStyles.HexNumber));
          using (var bitmap = new Bitmap(window.width, window.height))
          using (var graphics = Graphics.FromImage(bitmap)) {
            IntPtr hdc = graphics.GetHdc();
            bool printed = PrintWindow(hwnd, hdc, 2);
            graphics.ReleaseHdc(hdc);
            if (!printed) throw new InvalidOperationException("PrintWindow failed");
            bitmap.Save(args[2], ImageFormat.Png);
          }
          Console.Write("{\"captured\":true}"); return 0;
        }
        Console.Write("{\"captured\":false}"); return 2;
      }
      return 2;
    } catch (Exception error) {
      Console.Error.WriteLine(error.GetType().Name + ": " + error.Message); return 1;
    }
  }
}
`;

const csc = path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const probeSource = path.join(tools, "PortableProbe.cs");
const probe = path.join(tools, "PortableProbe.exe");
fs.writeFileSync(probeSource, PROBE_SOURCE, "utf8");
const compiled = spawnSync(csc, ["/nologo", "/utf8output", "/target:exe", `/out:${probe}`,
  "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll",
  "/reference:System.Web.Extensions.dll", probeSource], { encoding: "utf8", windowsHide: true, timeout: 120000 });
assert(compiled.status === 0, `验收探针编译失败：${compiled.stderr || compiled.stdout}`);

/** @param args 探针参数 @param allowFailure 是否允许原样返回非零 @returns 脱敏进程结果 */
function runProbe(args, allowFailure = false) {
  const result = spawnSync(probe, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (!allowFailure) assert(result.status === 0, `探针失败：${result.stderr || result.stdout}`);
  return result;
}

/** @param pid 精确进程号 @returns 该进程顶层窗口 */
function windows(pid) {
  return JSON.parse(runProbe(["windows", String(pid)]).stdout);
}

/** @returns 可读取身份的进程列表；不含环境或命令行 */
function processes() {
  const result = runProbe(["processes"]);
  return JSON.parse(result.stdout).filter((item) => item.pid !== result.pid);
}

/** @param directory 专有旧版本目录 @param value 哈希 @param product 产品标记 @returns 无 */
function writeOwnedManifest(directory, value, product = "CopilotCC") {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "payload-manifest.json"), JSON.stringify({
    schemaVersion: 1, product, payloadHash: value,
  }), "utf8");
}

const runtimeRoot = path.join(home, "runtime");
const current = path.join(runtimeRoot, expectedHash);
const oldHash = "1".repeat(64);
const stagingHash = "2".repeat(64);
const junctionHash = "3".repeat(64);
const foreignHash = "4".repeat(64);
const activeHash = "5".repeat(64);
const oldDir = path.join(runtimeRoot, oldHash);
const staging = path.join(runtimeRoot, `.extracting-${stagingHash}-${"a".repeat(32)}`);
const junctionDir = path.join(runtimeRoot, junctionHash);
const foreignDir = path.join(runtimeRoot, foreignHash);
const unknownDir = path.join(runtimeRoot, "user-owned");
writeOwnedManifest(oldDir, oldHash);
writeOwnedManifest(junctionDir, junctionHash);
writeOwnedManifest(foreignDir, foreignHash, "OtherProduct");
fs.mkdirSync(staging, { recursive: true });
fs.writeFileSync(path.join(staging, ".copilotcc-extracting"), `CopilotCC\n${stagingHash}\n`, "utf8");
fs.mkdirSync(unknownDir, { recursive: true });
fs.writeFileSync(path.join(unknownDir, "keep.txt"), "keep\n", "utf8");
const junctionTarget = path.join(root, "junction-target");
fs.mkdirSync(junctionTarget);
fs.writeFileSync(path.join(junctionTarget, "keep.txt"), "keep\n", "utf8");
const linked = spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", path.join(junctionDir, "linked"), junctionTarget], {
  encoding: "utf8", windowsHide: true, timeout: 10000,
});
assert(linked.status === 0, `创建隔离 junction 失败：${linked.stderr || linked.stdout}`);

const children = new Set();
const environment = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  CCC_BRIDGE_HOME: home,
  CLAUDE_CONFIG_DIR: claudeConfig,
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  ANTHROPIC_API_KEY: "mock-local-only",
  ANTHROPIC_AUTH_TOKEN: "mock-local-only",
  NO_PROXY: "127.0.0.1,localhost",
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
};
delete environment.CCC_PORTABLE_RUNTIME_DIR;
delete environment.CLAUDE_CODE_CHILD_SESSION;

/** @param args 内层参数 @param watchCleanup 是否记录首次清理顺序 @returns 外层真实退出码 */
async function runOuter(args = ["--smoke", "win32", "x64"], watchCleanup = false) {
  // 与用户双击一致：不能给 WinForms 外层传 SW_HIDE，否则正常进度窗也会被隐藏。
  const child = spawn(appExe, args, { cwd, env: environment, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-2000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-2000); });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const screenshot = path.join(root, "portable-startup-progress.png");
  const watchResult = path.join(root, "portable-window-watch.json");
  const watcher = watchCleanup ? spawn(probe, ["watch", String(child.pid), screenshot, watchResult], {
    cwd, windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
  }) : null;
  if (watcher) children.add(watcher);
  const watcherExited = watcher ? new Promise((resolve) => watcher.once("exit", resolve)) : null;
  const deadline = Date.now() + 120000;
  while (child.exitCode === null && Date.now() < deadline) {
    if (watchCleanup) {
      const state = { at: Date.now(), old: fs.existsSync(oldDir), staging: fs.existsSync(staging), current: fs.existsSync(current) };
      const events = evidence.observations.startupEvents;
      const previous = events[events.length - 1];
      if (!previous || previous.old !== state.old || previous.staging !== state.staging || previous.current !== state.current) events.push(state);
    }
    await delay(40);
  }
  assert(child.exitCode !== null, "单文件启动器 120 秒未退出");
  const code = await exited;
  if (watcher) {
    const watchDeadline = Date.now() + 5000;
    while (watcher.exitCode === null && Date.now() < watchDeadline) await delay(20);
    assert(watcher.exitCode !== null, "进度窗口监视器未退出");
    await watcherExited;
    children.delete(watcher);
    if (fs.existsSync(watchResult)) {
      const observed = JSON.parse(fs.readFileSync(watchResult, "utf8"));
      evidence.observations.progressWindow = {
        seen: observed.seen, className: observed.className, width: observed.width, height: observed.height,
      };
      evidence.observations.progressScreenshotSaved = observed.captured && fs.existsSync(screenshot)
        && fs.statSync(screenshot).size > 0;
      evidence.startupProgressVisible = observed.seen && evidence.observations.progressScreenshotSaved;
    }
  }
  children.delete(child);
  assert(code === 0, `单文件启动失败，exit=${code}；${output}`);
  return code;
}

/** @returns 只清理可执行路径位于本轮 root 内的进程 */
function cleanupProcesses() {
  const remaining = [];
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owned = processes().filter((item) => inside(root, item.executable));
    if (owned.length === 0) break;
    for (const item of owned) {
      const result = runProbe(["kill", String(item.pid), item.executable, String(item.startTicks)], true);
      if (result.status !== 0) errors.push(`${item.pid}:${result.stderr.trim().slice(0, 120)}`);
    }
    if (attempt < 2) spawnSync("cmd.exe", ["/d", "/c", "ping", "-n", "2", "127.0.0.1"], { windowsHide: true, timeout: 3000 });
  }
  for (const item of processes().filter((entry) => inside(root, entry.executable))) {
    remaining.push({ pid: item.pid, executable: path.relative(root, item.executable) });
  }
  evidence.observations.cleanup = { remaining, errors };
  evidence.cleanupEmpty = remaining.length === 0 && errors.length === 0;
}

try {
  const pe = fs.readFileSync(appExe);
  const peOffset = pe.readUInt32LE(0x3c);
  evidence.guiSubsystem = pe.toString("ascii", peOffset, peOffset + 4) === "PE\0\0"
    && pe.readUInt16LE(peOffset + 24 + 68) === 2;
  evidence.portableSingleFileOnly = fs.readdirSync(appDir).length === 1 && fs.readdirSync(appDir)[0] === "CopilotCC.exe";

  await runOuter(["--smoke", "win32", "x64"], true);
  evidence.currentHashMatchesBuild = fs.existsSync(path.join(current, "payload-manifest.json"));
  evidence.oldVersionRemoved = !fs.existsSync(oldDir);
  evidence.staleStagingRemoved = !fs.existsSync(staging);
  evidence.unknownPreserved = fs.readFileSync(path.join(unknownDir, "keep.txt"), "utf8") === "keep\n";
  evidence.junctionPreserved = fs.existsSync(junctionDir) && fs.readFileSync(path.join(junctionTarget, "keep.txt"), "utf8") === "keep\n";
  evidence.foreignProductPreserved = fs.existsSync(foreignDir);
  const events = evidence.observations.startupEvents;
  const removal = events.findIndex((event) => !event.old && !event.staging);
  const publish = events.findIndex((event) => event.current);
  evidence.cleanupBeforeExtract = removal >= 0 && publish > removal;

  for (let index = 0; index < 2; index += 1) await runOuter();
  const stagingLeft = fs.readdirSync(runtimeRoot).filter((name) => name.startsWith(".extracting-"));
  evidence.repeatedStartsBounded = stagingLeft.length === 0 && fs.existsSync(current)
    && fs.readdirSync(runtimeRoot).filter((name) => /^[a-f0-9]{64}$/.test(name)).length === 3;

  const manifest = JSON.parse(fs.readFileSync(path.join(current, "payload-manifest.json"), "utf8"));
  const nativeRecord = manifest.files.find((file) => file.path === "pty-manifest.json");
  const nativeFile = path.join(current, "pty-manifest.json");
  fs.appendFileSync(nativeFile, "tampered\n", "utf8");
  await runOuter();
  evidence.tamperedRebuilt = hash(fs.readFileSync(nativeFile)) === nativeRecord.sha256
    && !fs.existsSync(path.join(current, "payload-content.bin"))
    && !fs.existsSync(path.join(current, "payload-storage.json"));

  const activeDir = path.join(runtimeRoot, activeHash);
  fs.cpSync(current, activeDir, { recursive: true, force: false, errorOnExist: true });
  const activeManifest = JSON.parse(fs.readFileSync(path.join(activeDir, "payload-manifest.json"), "utf8"));
  activeManifest.payloadHash = activeHash;
  fs.writeFileSync(path.join(activeDir, "payload-manifest.json"), JSON.stringify(activeManifest), "utf8");
  const activeHome = home;
  const activeExe = path.join(activeDir, "ccc-bridge.exe");
  const active = spawn(activeExe, ["start"], {
    cwd: activeDir,
    env: { ...environment, CCC_BRIDGE_HOME: activeHome, CCC_PORTABLE_RUNTIME_DIR: activeDir },
    windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
  });
  children.add(active);
  const activeDeadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(activeHome, "runtime.json")) && Date.now() < activeDeadline) await delay(100);
  assert(fs.existsSync(path.join(activeHome, "runtime.json")), "旧版本活动桥接未启动");
  await runOuter();
  evidence.activePreserved = fs.existsSync(activeExe) && active.exitCode === null;
  const activeIdentity = processes().find((item) => item.pid === active.pid && path.resolve(item.executable) === activeExe);
  assert(activeIdentity, "活动旧版本身份无法核对");
  assert(runProbe(["kill", String(active.pid), activeIdentity.executable, String(activeIdentity.startTicks)]).status === 0,
    "定向结束隔离活动桥接失败");
  children.delete(active);
  await runOuter();
  evidence.oldVersionRemoved = evidence.oldVersionRemoved && !fs.existsSync(activeDir);
  evidence.noSidecarFiles = fs.readdirSync(appDir).length === 1 && fs.readdirSync(appDir)[0] === "CopilotCC.exe";
} catch (error) {
  evidence.observations.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try { cleanupProcesses(); } catch (error) {
    evidence.observations.cleanup.errors.push(error instanceof Error ? error.message : String(error));
    evidence.cleanupEmpty = false;
  }
  const required = [
    "portableSingleFileOnly", "startupProgressVisible", "cleanupBeforeExtract", "oldVersionRemoved",
    "unknownPreserved", "activePreserved", "staleStagingRemoved", "tamperedRebuilt",
    "repeatedStartsBounded", "noSidecarFiles", "cleanupEmpty", "guiSubsystem",
    "junctionPreserved", "foreignProductPreserved", "currentHashMatchesBuild",
  ];
  evidence.ok = required.every((key) => evidence[key] === true) && !evidence.observations.error;
  fs.writeFileSync(resultFile, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`PORTABLE_VERIFICATION=${JSON.stringify({ ok: evidence.ok, resultFile, required: Object.fromEntries(required.map((key) => [key, evidence[key]])) })}`);
  if (!evidence.ok) process.exitCode = 1;
}
