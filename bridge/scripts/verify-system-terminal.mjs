/**
 * 阶段 A 系统终端端到端验收：编译 exe + 真实 Chrome + 真实 Windows 窗口 + 隔离假 CLI。
 * 用法：node bridge/scripts/verify-system-terminal.mjs --root <已批准根目录下的新目录> [--negative-control hooks]
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const APPROVED_ROOT = "D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_PATH = path.join(PROJECT_ROOT, "extension", ".output", "chrome-mv3");
const DIST_DIR = path.join(PROJECT_ROOT, "bridge", "dist", "ccc-bridge-win-x64");
const DIST_EXE = path.join(DIST_DIR, "ccc-bridge.exe");
const DIST_TERMINAL_EXE = path.join(DIST_DIR, "ccc-terminal.exe");
const FAKE_CLI = path.join(APPROVED_ROOT, "bin", "fake-claude.exe");
const EXTENSION_ID = "cnalihjaacpahpjkpneacjcfbhboglno";
const PAGE_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;
const INITIAL_SID = "11111111-1111-4111-8111-111111111111";
const EXTERNAL_SID = "22222222-2222-4222-8222-222222222222";
const token = randomBytes(24).toString("base64url");
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

/**
 * 条件轮询；超时与连接错误都不能被记作功能通过。
 * @param fn 返回真值即完成的异步检查
 * @param label 验收步骤
 * @param timeoutMs 超时毫秒
 * @returns 检查返回的真值
 */
async function waitFor(fn, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); } catch { /* 启动中的目标尚不可读 */ }
    if (last) return last;
    await delay(100);
  }
  throw new Error(`等待超时：${label}；最后值=${JSON.stringify(last)}`);
}

const rootArgIndex = process.argv.indexOf("--root");
const root = rootArgIndex >= 0 ? path.resolve(process.argv[rootArgIndex + 1] ?? "") : "";
const negativeIndex = process.argv.indexOf("--negative-control");
const negativeControl = negativeIndex >= 0 ? process.argv[negativeIndex + 1] : null;
const consoleSubsystemProbe = process.argv.includes("--console-subsystem-probe");
assert(root && inside(APPROVED_ROOT, root), "root 必须严格位于批准的 dual-terminal-20261110 目录内");
assert(!negativeControl || negativeControl === "hooks", "仅支持 --negative-control hooks");
if (fs.existsSync(root)) assert(fs.readdirSync(root).length === 0, "root 必须为空；不覆盖或删除旧证据");
const home = path.join(root, "home");
const claudeConfig = path.join(root, "claude-config");
const cwd = path.join(root, "cwd");
const binDir = path.join(root, "bin");
const toolsDir = path.join(root, "tools");
for (const dir of [root, home, claudeConfig, cwd, binDir, toolsDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const dir of [home, claudeConfig, cwd]) assert(inside(root, dir), "隔离路径越出 root");
process.chdir(cwd);
assert(!inside(PROJECT_ROOT, process.cwd()) && path.resolve(process.cwd()) !== PROJECT_ROOT, "验收 CWD 不得位于项目树内");
assert(process.platform === "win32", "本脚本当前只执行真实 Windows 验收");
for (const file of [DIST_EXE, DIST_TERMINAL_EXE, FAKE_CLI, path.join(EXTENSION_PATH, "manifest.json")]) assert(fs.existsSync(file), `缺少验收产物：${file}`);
const isolatedExe = path.join(binDir, "ccc-bridge.exe");
const isolatedTerminalExe = path.join(binDir, "ccc-terminal.exe");
fs.copyFileSync(DIST_EXE, isolatedExe);
fs.copyFileSync(DIST_TERMINAL_EXE, isolatedTerminalExe);
if (consoleSubsystemProbe) {
  // 单变量诊断：只把隔离副本从 GUI 改为 Console，不改动生产 exe 或其他链路。
  const image = fs.readFileSync(isolatedExe);
  const pe = image.readUInt32LE(0x3c);
  const subsystem = pe + 24 + 68;
  assert(image.toString("ascii", pe, pe + 4) === "PE\0\0" && image.readUInt16LE(subsystem) === 2,
    "Console 对照探针要求原始隔离副本为有效 GUI PE");
  image.writeUInt16LE(3, subsystem);
  fs.writeFileSync(isolatedExe, image);
}

const evidence = {
  windowsTerminalVisible: false,
  slowSystemOpenSucceeded: false,
  slowSystemOpenClearedStaleError: false,
  timedOutLateChildCancelled: false,
  fallbackConsoleVisible: false,
  fallbackReported: false,
  resumedInitialSession: false,
  clearFollowedNewSession: false,
  resumeFollowedSelectedSession: false,
  ordinaryExternalSessionListedWithoutTakeover: false,
  compactKeptSessionAndCollapsedSummary: false,
  taskReportCollapsed: false,
  sidepanelReadonly: false,
  popupReadonly: false,
  directWriteRequestsRejected: false,
  exitRestoredLastHookSession: false,
  degradedStayedReadonly: false,
  restartRecoveredSystemLease: false,
  unknownIdentityRequiredManualRelease: false,
  commandHooksWithoutFailure: false,
  compiledExeOutsideProjectTree: inside(APPROVED_ROOT, isolatedExe) && !inside(PROJECT_ROOT, isolatedExe),
  realApiCalled: false,
  runtimeErrors: [],
  negativeControl,
  observations: { consoleSubsystemProbe },
  unverifiedPlatforms: { macos: "未在 macOS arm64 运行，Terminal.app 尚未验收" },
};
let bridgeChild = null;
let chromeChild = null;
let browserCdp = null;
let control = null;
let runtimePort = 0;
let bridgeEnvironment = null;
let upstreamRequests = 0;
const externalChildren = new Set();
const pages = [];
const terminalWindows = new Set();
const terminalConsolePids = new Map();
const ownedProcesses = new Map();
const resultFile = negativeControl ? path.join(root, "red-result.json") : path.join(root, "system-verification.json");

/** @returns 无返回值；只写不含 token/环境的结果 JSON */
function saveEvidence() {
  fs.writeFileSync(resultFile, JSON.stringify(evidence, null, 2), "utf8");
}

const upstream = http.createServer((req, res) => {
  upstreamRequests += 1;
  req.resume();
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { type: "local_only", message: "intentional isolated rejection" } }));
});
await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress !== "string", "本机假上游监听失败");

const WINDOW_PROBE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class WindowProbe {
  public class Info {
    public string handle;
    public string title;
    public string className;
    public string processName;
    public int pid;
    public bool visible;
    public int left, top, width, height;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
    public int KeyDown; public ushort RepeatCount, VirtualKeyCode, VirtualScanCode;
    public char UnicodeChar; public uint ControlKeyState;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct INPUT_RECORD {
    public ushort EventType; public KEY_EVENT_RECORD KeyEvent;
  }
  private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr extra);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern short VkKeyScan(char character);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll", EntryPoint="WriteConsoleInputW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(
    IntPtr input, INPUT_RECORD[] records, uint length, out uint written);

  static string SendConsole(uint pid, string value) {
    FreeConsole();
    if (!AttachConsole(pid)) {
      int error = Marshal.GetLastWin32Error();
      throw new System.ComponentModel.Win32Exception(error, "AttachConsole failed: " + error);
    }
    // AttachConsole 不会重定向调用方既有 std handles，必须显式打开新控制台的 CONIN$。
    var input = CreateFile("CONIN$", 0xc0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (input == IntPtr.Zero || input == new IntPtr(-1)) {
      int error = Marshal.GetLastWin32Error();
      throw new System.ComponentModel.Win32Exception(error, "CreateFile(CONIN$) failed: " + error);
    }
    var records = new List<INPUT_RECORD>();
    foreach (char c in (value + "\r")) {
      ushort virtualKey = c == '\r' ? (ushort)0x0d : (ushort)(VkKeyScan(c) & 0xff);
      ushort scanCode = (ushort)(MapVirtualKey(virtualKey, 0) & 0xff);
      records.Add(new INPUT_RECORD { EventType=1, KeyEvent=new KEY_EVENT_RECORD {
        KeyDown=1, RepeatCount=1, VirtualKeyCode=virtualKey, VirtualScanCode=scanCode, UnicodeChar=c } });
      records.Add(new INPUT_RECORD { EventType=1, KeyEvent=new KEY_EVENT_RECORD {
        KeyDown=0, RepeatCount=1, VirtualKeyCode=virtualKey, VirtualScanCode=scanCode, UnicodeChar=c } });
    }
    uint written;
    bool succeeded = WriteConsoleInput(input, records.ToArray(), (uint)records.Count, out written);
    CloseHandle(input);
    if (!succeeded || written != records.Count) {
      int error = Marshal.GetLastWin32Error();
      throw new System.ComponentModel.Win32Exception(error, "WriteConsoleInput failed: " + error + ", succeeded=" + succeeded + ", written=" + written + ", expected=" + records.Count);
    }
    return new JavaScriptSerializer().Serialize(new { sent=true, consolePid=pid, records=written });
  }

  static string Text(IntPtr hwnd, bool className) {
    var value = new StringBuilder(1024);
    if (className) GetClassName(hwnd, value, value.Capacity); else GetWindowText(hwnd, value, value.Capacity);
    return value.ToString();
  }
  static Info Read(IntPtr hwnd) {
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    RECT rect; GetWindowRect(hwnd, out rect);
    string process = "";
    try { process = Process.GetProcessById((int)pid).ProcessName; } catch {}
    return new Info { handle=hwnd.ToInt64().ToString(), title=Text(hwnd,false), className=Text(hwnd,true),
      processName=process, pid=(int)pid, visible=IsWindowVisible(hwnd), left=rect.Left, top=rect.Top,
      width=rect.Right-rect.Left, height=rect.Bottom-rect.Top };
  }
  static List<Info> List() {
    var result = new List<Info>();
    EnumWindows((hwnd, extra) => { var item=Read(hwnd); if (item.visible) result.Add(item); return true; }, IntPtr.Zero);
    return result;
  }
  static string SendKeysLiteral(string value) {
    var output = new StringBuilder();
    foreach (char c in value) {
      if ("+^%~{}[]()".IndexOf(c) >= 0) output.Append('{').Append(c).Append('}'); else output.Append(c);
    }
    return output.ToString();
  }
  static void Activate(IntPtr hwnd) {
    ShowWindowAsync(hwnd, 9); BringWindowToTop(hwnd); SetForegroundWindow(hwnd); Thread.Sleep(250);
  }
  public static int MainCore(string[] args) {
    Console.OutputEncoding = Encoding.UTF8;
    if (args.Length == 1 && args[0] == "list") {
      Console.Write(new JavaScriptSerializer().Serialize(List())); return 0;
    }
    if (args.Length < 2) return 2;
    if (args[0] == "console-send" && args.Length == 3) {
      Console.Write(SendConsole(uint.Parse(args[1]), args[2])); return 0;
    }
    var hwnd = new IntPtr(long.Parse(args[1]));
    if (args[0] == "close" && args.Length == 2) {
      // 只关闭脚本已登记的隔离窗口，用于人工解除后不再存在 Hook 端点的终端。
      if (!PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "PostMessage(WM_CLOSE) failed");
      }
      Console.Write(new JavaScriptSerializer().Serialize(new { sent=true, target=hwnd.ToInt64().ToString() }));
      return 0;
    }
    if (args[0] == "send" && args.Length == 3) {
      Activate(hwnd);
      // 目标未真正取得前台时宁可不发送，避免测试按键落入其他窗口。
      if (GetForegroundWindow() != hwnd) {
        Console.Write(new JavaScriptSerializer().Serialize(new { sent=false, foreground=GetForegroundWindow().ToInt64().ToString(), target=hwnd.ToInt64().ToString() }));
        return 4;
      }
      SendKeys.SendWait(SendKeysLiteral(args[2])); SendKeys.SendWait("{ENTER}");
      Console.Write(new JavaScriptSerializer().Serialize(new { sent=true, foreground=GetForegroundWindow().ToInt64().ToString(), target=hwnd.ToInt64().ToString() }));
      return 0;
    }
    if (args[0] == "capture" && args.Length == 3) {
      Activate(hwnd); var item=Read(hwnd);
      using (var bitmap = new Bitmap(item.width, item.height)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          var hdc = graphics.GetHdc();
          try {
            if (!PrintWindow(hwnd, hdc, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
          } finally { graphics.ReleaseHdc(hdc); }
        }
        bitmap.Save(args[2], System.Drawing.Imaging.ImageFormat.Png);
      }
      Console.Write(new JavaScriptSerializer().Serialize(item)); return 0;
    }
    return 2;
  }
  [STAThread] public static int Main(string[] args) {
    try { return MainCore(args); }
    catch (Exception ex) {
      Console.Error.WriteLine("WINDOW_PROBE_EXCEPTION=" + ex.GetType().FullName + ": " + ex.Message);
      return 3;
    }
  }
}
`;

const CONSOLE_SHIM_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public static class ConsoleShim {
  static readonly string LogFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "console-shim-events.log");
  static void Log(string kind, string detail) {
    File.AppendAllText(LogFile, DateTime.UtcNow.ToString("o") + " " + kind + " " + detail + "\n", new UTF8Encoding(false));
  }
  static string Quote(string value) {
    var output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '\"') output.Append('\\', slashes * 2 + 1).Append('\"');
      else { output.Append('\\', slashes).Append(c); }
      slashes = 0;
    }
    return output.Append('\\', slashes * 2).Append('\"').ToString();
  }
  static async Task Copy(TextReader input, TextWriter output, string name) {
    var buffer = new char[4096];
    long total = 0;
    while (true) {
      int count = await input.ReadAsync(buffer, 0, buffer.Length);
      if (count <= 0) break;
      total += count;
      await output.WriteAsync(buffer, 0, count);
      await output.FlushAsync();
    }
    Log("copy-eof", name + " chars=" + total);
  }
  public static int Main(string[] args) {
    try {
      Log("start", "inputRedirected=" + Console.IsInputRedirected + " outputRedirected=" + Console.IsOutputRedirected);
      var actual = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake-claude.exe");
      var start = new ProcessStartInfo {
        FileName = actual, WorkingDirectory = Environment.CurrentDirectory,
        UseShellExecute = false, CreateNoWindow = false,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
      };
      var command = new StringBuilder();
      foreach (string arg in args) {
        if (command.Length > 0) command.Append(' ');
        command.Append(Quote(arg));
      }
      start.Arguments = command.ToString();
      var child = Process.Start(start);
      bool streamJson = Array.IndexOf(args, "--input-format") >= 0 && Array.IndexOf(args, "stream-json") >= 0;
      bool versionProbe = Array.IndexOf(args, "--version") >= 0;
      Log("child-started", "pid=" + child.Id + " streamJson=" + streamJson + " versionProbe=" + versionProbe);
      var stdout = Copy(child.StandardOutput, Console.Out, "stdout");
      var stderr = Copy(child.StandardError, Console.Error, "stderr");
      var exited = Task.Run(() => child.WaitForExit());
      while (!child.HasExited) {
        var read = Task.Run(() => Console.In.ReadLine());
        if (Task.WaitAny(read, exited) == 1) { Log("console-input", "child-exited"); break; }
        string line = read.Result;
        if (line == null) { Log("console-input", "eof"); break; }
        Log("console-input", line);
        child.StandardInput.WriteLine(line);
        child.StandardInput.Flush();
        Log("child-input", "flushed");
      }
      try { Log("closing-input", ""); child.StandardInput.Close(); Log("closed-input", ""); } catch {}
      Log("waiting-exit", "hasExited=" + child.HasExited);
      child.WaitForExit();
      Log("child-exit", "code=" + child.ExitCode);
      Task.WaitAll(stdout, stderr);
      Log("copy-complete", "");
      return child.ExitCode;
    } catch (Exception ex) {
      Log("exception", ex.GetType().FullName);
      Console.Error.WriteLine("CONSOLE_SHIM_EXCEPTION=" + ex.GetType().FullName);
      return 3;
    }
  }
}
`;

const DELAYED_WT_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class DelayedWindowsTerminal {
  static string Quote(string value) {
    var output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '\"') output.Append('\\', slashes * 2 + 1).Append('\"');
      else { output.Append('\\', slashes).Append(c); }
      slashes = 0;
    }
    return output.Append('\\', slashes * 2).Append('\"').ToString();
  }
  public static int Main(string[] args) {
    string delayFile = Environment.GetEnvironmentVariable("CCC_VERIFY_WT_DELAY_FILE");
    string logFile = Environment.GetEnvironmentVariable("CCC_VERIFY_WT_LOG_FILE");
    string actual = Environment.GetEnvironmentVariable("CCC_VERIFY_REAL_WT");
    if (String.IsNullOrEmpty(delayFile) || String.IsNullOrEmpty(logFile) || String.IsNullOrEmpty(actual)) return 3;
    int delayMs;
    if (!Int32.TryParse(File.ReadAllText(delayFile).Trim(), out delayMs) || delayMs < 0 || delayMs > 30000) return 4;
    File.AppendAllText(logFile, "{\"pid\":" + Process.GetCurrentProcess().Id + ",\"delayMs\":" + delayMs + "}\n",
      new UTF8Encoding(false));
    Thread.Sleep(delayMs);
    var command = new StringBuilder();
    foreach (string arg in args) {
      if (command.Length > 0) command.Append(' ');
      command.Append(Quote(arg));
    }
    var start = new ProcessStartInfo {
      FileName = actual, Arguments = command.ToString(), WorkingDirectory = Environment.CurrentDirectory,
      UseShellExecute = false, CreateNoWindow = false,
    };
    Process.Start(start);
    return 0;
  }
}
`;

const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const windowSource = path.join(toolsDir, "WindowProbe.cs");
const windowProbe = path.join(toolsDir, "WindowProbe.exe");
fs.writeFileSync(windowSource, WINDOW_PROBE_SOURCE, "utf8");
const compile = spawnSync(csc, ["/nologo", "/target:exe", `/out:${windowProbe}`,
  "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll", windowSource], {
  cwd: toolsDir, encoding: "utf8", windowsHide: true,
});
assert(compile.status === 0 && fs.existsSync(windowProbe), `窗口探针编译失败：${compile.stderr || compile.stdout}`);
const consoleShimSource = path.join(toolsDir, "ConsoleShim.cs");
const consoleShim = path.join(binDir, "fake-claude-console.exe");
fs.copyFileSync(FAKE_CLI, path.join(binDir, "fake-claude.exe"));
fs.writeFileSync(consoleShimSource, CONSOLE_SHIM_SOURCE, "utf8");
const shimCompile = spawnSync(csc, ["/nologo", "/target:exe", `/out:${consoleShim}`,
  "/reference:System.dll", "/reference:System.Core.dll", consoleShimSource], {
  cwd: toolsDir, encoding: "utf8", windowsHide: true,
});
assert(shimCompile.status === 0 && fs.existsSync(consoleShim), `控制台转发层编译失败：${shimCompile.stderr || shimCompile.stdout}`);

const wtShimDir = path.join(toolsDir, "wt-shim");
fs.mkdirSync(wtShimDir);
const wtShim = path.join(wtShimDir, "wt.exe");
const wtDelayFile = path.join(toolsDir, "wt-delay.txt");
const wtShimLog = path.join(toolsDir, "wt-shim-events.jsonl");
const realWt = spawnSync("where.exe", ["wt.exe"], { encoding: "utf8", windowsHide: true });
const realWtPath = realWt.status === 0 ? realWt.stdout.split(/\r?\n/)[0]?.trim() : "";
// Windows App Execution Alias 可被 CreateProcess 解析，但 fs.existsSync 可能返回 false。
assert(realWtPath.toLowerCase().endsWith("wt.exe"), "PATH 中找不到真实 Windows Terminal，无法执行慢启动验收");
fs.writeFileSync(wtDelayFile, "0", "utf8");
const wtShimSource = path.join(toolsDir, "DelayedWindowsTerminal.cs");
fs.writeFileSync(wtShimSource, DELAYED_WT_SOURCE, "utf8");
const wtCompile = spawnSync(csc, ["/nologo", "/target:exe", `/out:${wtShim}`,
  "/reference:System.dll", "/reference:System.Core.dll", wtShimSource], {
  cwd: toolsDir, encoding: "utf8", windowsHide: true,
});
assert(wtCompile.status === 0 && fs.existsSync(wtShim), `受控 WT 启动器编译失败：${wtCompile.stderr || wtCompile.stdout}`);

/** @returns 当前可见顶层窗口的非敏感元数据 */
function listWindows() {
  return JSON.parse(execFileSync(windowProbe, ["list"], { encoding: "utf8", windowsHide: true }));
}

/** @param baseline 原窗口集合 @param backend 实际终端后端 @returns 新出现且可见的目标窗口 */
async function findTerminalWindow(baseline, backend) {
  return waitFor(() => {
    const expectedClass = backend === "windows-terminal" ? "CASCADIA_HOSTING_WINDOW_CLASS" : "ConsoleWindowClass";
    return listWindows().find((item) => !baseline.has(item.handle) && item.visible
      && item.className === expectedClass) ?? null;
  }, `${backend} 新顶层窗口可见`, 15000);
}

/** @param pid 本隔离包装进程 PID @param command 假 CLI 命令 @returns 原生控制台输入结果 */
function sendTerminalCommand(pid, command) {
  try {
    const result = JSON.parse(execFileSync(windowProbe, ["console-send", String(pid), command], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    }));
    evidence.observations.lastSend = result;
    return result;
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      try { evidence.observations.lastSend = JSON.parse(String(error.stdout)); } catch { /* 保留原始异常 */ }
    }
    throw error;
  }
}

/** @param handle 窗口句柄 @param name 截图文件名 @returns 截图时的窗口元数据 */
function captureTerminal(handle, name) {
  return JSON.parse(execFileSync(windowProbe, ["capture", handle, path.join(root, name)], {
    encoding: "utf8", windowsHide: true, timeout: 5000,
  }));
}

class Cdp {
  /** @param socket 已创建的 CDP WebSocket */
  constructor(socket) { this.ws = socket; this.nextId = 1; this.pending = new Map(); this.errors = []; }
  /** @returns 连接并监听异常后的 Promise */
  connect() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
      this.ws.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
        } else if (message.method === "Runtime.exceptionThrown") {
          this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
        } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
          this.errors.push(message.params.args.map((item) => item.value ?? item.description ?? "").join(" "));
        }
      });
    });
  }
  /** @param method CDP 方法 @param params 参数 @returns CDP 结果 */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/** @param page CDP 页面 @param expression JS 表达式 @returns 表达式值 */
async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

/** @param target CDP target @param label 视图名称 @returns 已启用错误监听的页面 */
async function attachPage(target, label) {
  assert(target && typeof target.webSocketDebuggerUrl === "string", `CDP target 不可连接：${label}`);
  const page = new Cdp(new WebSocket(target.webSocketDebuggerUrl));
  page.label = label;
  await page.connect();
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  pages.push(page);
  return page;
}

/** @returns CDP 页面 target 列表 */
async function targets() {
  return (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
}

/** @param page 页面 @param name 文件名 @returns 无返回值 */
async function screenshot(page, name) {
  const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, name), Buffer.from(shot.data, "base64"));
}

/** @param pid 进程 PID @returns 当前可执行路径与启动时间，查询不到时返回 null */
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit 3 }; [Console]::Out.WriteLine($p.ExecutablePath); [Console]::Out.WriteLine($p.CreationDate.ToUniversalTime().ToString("o"))`;
  try {
    const stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 4000,
    });
    const [executable = "", startedAt = ""] = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!executable || !Number.isFinite(Date.parse(startedAt))) return null;
    return { pid, executable: executable.replace(/\\/g, "/"), startedAt: new Date(startedAt).toISOString() };
  } catch { return null; }
}

/** @param pid 进程 PID @returns 当前是否存活或不可判定 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** @returns 无返回值；只登记本轮受控 WT 包装，便于异常时定向清理 */
function registerWtShims() {
  if (!fs.existsSync(wtShimLog)) return;
  for (const line of fs.readFileSync(wtShimLog, "utf8").split(/\r?\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    const identity = processIdentity(entry.pid);
    if (identity && path.resolve(identity.executable) === path.resolve(wtShim)) {
      ownedProcesses.set(entry.pid, { role: "delayed-wt", ...identity });
    }
  }
}

/** @returns 已启动的交互式假 CLI 数量；SDK stream-json 不计入 */
function interactiveFakeStartCount() {
  const file = path.join(binDir, "console-shim-events.log");
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter((line) => line.includes(" child-started ") && line.includes("streamJson=False")
      && line.includes("versionProbe=False")).length;
}

class ControlClient {
  /** @param socket 本机控制 WebSocket */
  constructor(socket) { this.ws = socket; this.inbox = []; }
  /** @returns 已连接并收集消息的客户端 */
  static async connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${runtimePort}/ws?token=${encodeURIComponent(token)}`);
    const client = new ControlClient(socket);
    socket.on("message", (data) => { try { client.inbox.push(JSON.parse(String(data))); } catch {} });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "client.ready" }));
    return client;
  }
  /** @param message 客户端协议帧 @returns 无返回值 */
  send(message) { this.ws.send(JSON.stringify(message)); }
  /** @param predicate 匹配函数 @param label 步骤 @param timeoutMs 超时 @returns 匹配帧 */
  wait(predicate, label, timeoutMs = 30000) {
    return waitFor(() => this.inbox.find(predicate) ?? null, label, timeoutMs);
  }
  /** @returns 最新公开终端状态 */
  terminalState() {
    return this.inbox.filter((message) => message.type === "terminal.state").at(-1)?.state ?? null;
  }
  /** @returns 无返回值 */
  close() { try { this.ws.close(); } catch {} }
}

/** @param extraEnv 仅本场景覆盖的环境 @returns 隔离桥接运行时信息 */
async function startBridge(extraEnv = {}) {
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({
    token, port: runtimePort, allowedOrigins: [`chrome-extension://${EXTENSION_ID}`], createdAt: new Date().toISOString(),
  }), "utf8");
  const env = {
    ...process.env,
    HOME: root, USERPROFILE: root, CCC_BRIDGE_HOME: home, CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_CODE_PATH: consoleShim, ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
    ANTHROPIC_API_KEY: "mock-local-only", ANTHROPIC_AUTH_TOKEN: "mock-local-only",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    PATH: `${wtShimDir};${process.env.PATH ?? ""}`,
    CCC_VERIFY_REAL_WT: realWtPath,
    CCC_VERIFY_WT_DELAY_FILE: wtDelayFile,
    CCC_VERIFY_WT_LOG_FILE: wtShimLog,
    ...extraEnv,
  };
  delete env.CCC_FAKE_CLI_DISABLE_HOOKS;
  if (extraEnv.CCC_FAKE_CLI_DISABLE_HOOKS) env.CCC_FAKE_CLI_DISABLE_HOOKS = extraEnv.CCC_FAKE_CLI_DISABLE_HOOKS;
  bridgeEnvironment = env;
  const stderrFd = fs.openSync(path.join(root, `bridge-${Date.now()}.stderr.log`), "a");
  bridgeChild = spawn(isolatedExe, ["start"], {
    cwd, env, windowsHide: true, stdio: ["ignore", "ignore", stderrFd],
  });
  const runtime = await waitFor(() => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(home, "runtime.json"), "utf8"));
      return value.pid === bridgeChild.pid && value.port > 0 ? value : null;
    } catch { return null; }
  }, "隔离桥接启动", 15000);
  runtimePort = runtime.port;
  if (control) control.close();
  control = await ControlClient.connect();
  // 本验收不扩展为“桥接进程崩溃后的草稿持久化”；重启后重新注入固定草稿，
  // 继续验证 lease 接管、恢复和 reconnect 本身不会清空它。
  control.send({ type: "chat.draft", text: "DRAFT_BEFORE_TERMINAL" });
  return runtime;
}

/** @returns 隔离桥接退出后的 Promise */
async function stopBridge() {
  if (control) { control.close(); control = null; }
  if (!bridgeChild || bridgeChild.exitCode !== null) { bridgeChild = null; return; }
  const child = bridgeChild;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(3000)]);
  bridgeChild = null;
}

let debugPort = 0;
let sidepanel = null;
let popup = null;

/** @returns 真实 Chrome side panel 与扩展自己创建的独立 popup */
async function startChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  const chrome = candidates.find((file) => fs.existsSync(file));
  assert(chrome, "找不到真实 Chrome");
  const profile = path.join(root, "chrome-profile");
  fs.mkdirSync(profile);
  chromeChild = spawn(chrome, [
    "--start-minimized", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  debugPort = await waitFor(() => {
    try {
      const first = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0];
      return /^\d+$/.test(first) ? Number(first) : null;
    } catch { return null; }
  }, "Chrome DevToolsActivePort");
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  browserCdp = new Cdp(new WebSocket(version.webSocketDebuggerUrl));
  await browserCdp.connect();
  const loaded = await browserCdp.send("Extensions.loadUnpacked", { path: EXTENSION_PATH });
  assert(loaded.id === EXTENSION_ID, `扩展 ID 不匹配：${loaded.id}`);
  const initialTarget = await waitFor(async () => (await targets()).find((target) => target.type === "page"
    && (target.url === "about:blank" || target.url.startsWith("chrome://newtab/"))) ?? null, "Chrome 初始标签");
  const setup = await attachPage(initialTarget, "setup");
  await setup.send("Page.navigate", { url: PAGE_URL });
  await waitFor(() => evaluate(setup, "document.readyState === 'complete' && Boolean(chrome.storage)"), "扩展设置页");
  const settings = { token, port: runtimePort, host: "127.0.0.1", folderHistory: [], attachEnabled: false,
    permissionMode: "auto", model: "", effort: "", fastMode: false, lastFolder: cwd };
  await evaluate(setup, `new Promise(resolve => chrome.storage.local.set({ "ccc.settings": ${JSON.stringify(settings)} }, () => resolve(true)))`);
  await setup.send("Page.reload", { ignoreCache: true });
  await waitFor(async () => (await evaluate(setup, "document.querySelector('.conn')?.textContent || ''")).includes("已连接"), "设置页连接");
  const opened = await evaluate(setup, `(async () => {
    const window = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: window.id });
    return true;
  })()`);
  assert(opened === true, "chrome.sidePanel.open 未执行");
  const sideTarget = await waitFor(async () => (await targets()).find((target) => target.url === PAGE_URL
    && target.id !== initialTarget.id && target.webSocketDebuggerUrl) ?? null, "真实 side panel target", 10000);
  sidepanel = await attachPage(sideTarget, "sidepanel");
  await sidepanel.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await setup.send("Page.navigate", { url: "about:blank" });
  await waitConnected(sidepanel, "真实 side panel 连接");
  const clicked = await evaluate(sidepanel, `(() => {
    const button = [...document.querySelectorAll('button[title]')].find(el => el.title.startsWith('在独立窗口打开此会话'));
    if (!button) return false; button.click(); return true;
  })()`);
  assert(clicked, "找不到真实弹出按钮");
  const popupTarget = await waitFor(async () => (await targets()).find((target) => target.url.startsWith(`${PAGE_URL}?`)
    && target.webSocketDebuggerUrl) ?? null, "独立聊天窗口 target");
  popup = await attachPage(popupTarget, "popup");
  await popup.send("Emulation.setDeviceMetricsOverride", { width: 520, height: 820, deviceScaleFactor: 1, mobile: false });
  await waitConnected(popup, "独立聊天窗口连接");
}

/** @param page 扩展视图 @param label 名称 @returns 已连接状态 */
async function waitConnected(page, label) {
  return waitFor(async () => (await evaluate(page, "document.querySelector('.conn')?.textContent || ''")).includes("已连接"), label);
}

/** @param page 视图 @param expected 是否应只读 @returns 草稿和禁用状态 */
async function readReadonly(page, expected) {
  return evaluate(page, `(() => {
    const textarea = document.querySelector('textarea');
    const terminalButton = document.querySelector('button[aria-label="在系统终端打开并继续当前会话"]');
    return {
      banner: document.querySelector('.terminal-readonly')?.textContent || '',
      draft: textarea?.value || '', disabled: textarea?.disabled ?? null,
      terminalDisabled: terminalButton?.disabled ?? null,
      busyStop: [...document.querySelectorAll('button')].some(el => (el.title || '').includes('停止本轮生成')),
    };
  })()`).then((state) => ({ ...state, expected }));
}

/** @param expected 是否应只读 @returns 两侧状态均符合且草稿保留 */
async function verifyReadonly(expected) {
  const side = await waitFor(async () => {
    const state = await readReadonly(sidepanel, expected);
    evidence.observations.lastReadonly = { expected, view: "sidepanel", state };
    return state.disabled === expected && state.draft === "DRAFT_BEFORE_TERMINAL" ? state : null;
  }, `side panel ${expected ? "只读" : "恢复"}`);
  const pop = await waitFor(async () => {
    const state = await readReadonly(popup, expected);
    evidence.observations.lastReadonly = { expected, view: "popup", state };
    return state.disabled === expected && state.draft === "DRAFT_BEFORE_TERMINAL" ? state : null;
  }, `popup ${expected ? "只读" : "恢复"}`);
  if (expected) {
    evidence.sidepanelReadonly = side.banner.includes("当前为只读镜像") && side.terminalDisabled && !side.busyStop;
    evidence.popupReadonly = pop.banner.includes("当前为只读镜像") && pop.terminalDisabled && !pop.busyStop;
  }
  return { side, pop };
}

/** @param handle 终端窗口 @param command 命令 @returns 无返回值 */
function sendTracked(handle, command) {
  assert(handle && terminalWindows.has(handle), "拒绝向未登记的非隔离窗口发送输入");
  const pid = terminalConsolePids.get(handle);
  assert(Number.isInteger(pid) && pid > 0, "目标窗口没有已登记的隔离控制台 PID");
  try {
    sendTerminalCommand(pid, command);
  } catch (error) {
    try { captureTerminal(handle, "input-send-failure.png"); } catch { /* 保留发送异常 */ }
    throw error;
  }
}

/** @param handle 已登记的隔离窗口 @returns 窗口关闭后的 Promise */
async function closeTracked(handle) {
  assert(handle && terminalWindows.has(handle), "拒绝关闭未登记的非隔离窗口");
  if (listWindows().every((item) => item.handle !== String(handle))) {
    terminalWindows.delete(handle);
    terminalConsolePids.delete(handle);
    return;
  }
  let result;
  try {
    result = JSON.parse(execFileSync(windowProbe, ["close", handle], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    }));
  } catch (error) {
    // 取消后的空终端可能已自行关窗；只在句柄确实消失时接受这个清理竞态。
    if (listWindows().every((item) => item.handle !== String(handle))) {
      terminalWindows.delete(handle);
      terminalConsolePids.delete(handle);
      return;
    }
    throw error;
  }
  assert(result.sent === true && result.target === String(handle), "隔离窗口关闭请求失败");
  await waitFor(() => listWindows().every((item) => item.handle !== String(handle)) ? true : null, "隔离窗口 WM_CLOSE");
  terminalWindows.delete(handle);
  terminalConsolePids.delete(handle);
}

/** @param file 转录文件 @param text 初始用户文本 @returns 无返回值 */
function seedTranscript(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", uuid: "initial-user", timestamp: new Date().toISOString(), message: { content: text } })}\n`, "utf8");
}

/** @param handle 新窗口句柄 @param leaseId 当前公开 lease @returns 无返回值 */
function trackTerminalConsole(handle, leaseId) {
  const status = JSON.parse(fs.readFileSync(path.join(home, "terminal", `${leaseId}.status.json`), "utf8"));
  assert(status.leaseId === leaseId && Number.isInteger(status.pid) && status.pid > 0,
    "隔离终端包装身份无效");
  terminalWindows.add(handle);
  terminalConsolePids.set(handle, status.pid);
  const identity = processIdentity(status.pid);
  if (identity) ownedProcesses.set(status.pid, { role: "system-terminal", leaseId, ...identity });
}

/** @returns 一次真实按钮点击的起点、starting lease 与点击后旧错误 */
async function beginSystemOpen() {
  const baseline = new Set(listWindows().map((item) => item.handle));
  const messageStart = control.inbox.length;
  const clickedAt = Date.now();
  const clicked = await evaluate(sidepanel, `(() => {
    const button = document.querySelector('button[aria-label="在系统终端打开并继续当前会话"]');
    if (!button || button.disabled) return false; button.click(); return true;
  })()`);
  assert(clicked, "系统终端真实按钮不可点击");
  const starting = await control.wait((message) => control.inbox.indexOf(message) >= messageStart
    && message.type === "terminal.state" && message.state.phase === "starting", "系统终端 starting lease", 10000);
  const errorAfterClick = await evaluate(sidepanel, "document.querySelector('.terminal-error')?.textContent || ''");
  return { baseline, messageStart, clickedAt, leaseId: starting.state.leaseId, errorAfterClick };
}

/** @returns 无返回值；20 秒失败后迟到的窗口不得启动交互式 Claude */
async function verifyLateChildCancelled() {
  fs.writeFileSync(wtDelayFile, "23000", "utf8");
  const interactiveStarts = interactiveFakeStartCount();
  const attempt = await beginSystemOpen();
  // 从点击起并行观察窗口；取消后的空终端可能在 20 秒超时回报后瞬间关窗。
  const lateWindowPromise = findTerminalWindow(attempt.baseline, "windows-terminal")
    .then((window) => { terminalWindows.add(window.handle); return window.handle; })
    .catch(() => null);
  await control.wait((message) => control.inbox.indexOf(message) >= attempt.messageStart
    && message.type === "terminal.state" && message.state.phase === "idle", "慢启动最终超时回到 idle", 27000);
  const uiError = await evaluate(sidepanel, "document.querySelector('.terminal-error')?.textContent || ''");
  assert(uiError.includes("终端启动失败"), "最终超时没有真实可见错误");
  const privateDir = path.join(home, "terminal");
  const cancelFile = path.join(privateDir, `${attempt.leaseId}.cancel`);
  await waitFor(() => fs.existsSync(cancelFile) ? true : null, "最终超时 cancel 文件", 3000);
  const statusFile = path.join(privateDir, `${attempt.leaseId}.status.json`);
  const status = await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { return null; }
  }, "迟到 child status", 10000);
  assert(status.leaseId === attempt.leaseId, "迟到 status 与失败 lease 不一致");
  await delay(700);
  assert(!fs.existsSync(path.join(privateDir, `${attempt.leaseId}.start`)), "超时 lease 被迟到写回 start");
  assert(fs.existsSync(cancelFile), "迟到 child 启动前 cancel 消失");
  assert(interactiveFakeStartCount() === interactiveStarts, "超时后的迟到 child 启动了无 lease Claude");
  assert(control.terminalState()?.phase === "idle", "迟到 status 重新抢占了已失败 lease");
  const notice = await evaluate(sidepanel, "document.querySelector('.terminal-notice')?.textContent || ''");
  assert(!notice.includes("终端已打开"), "迟到窗口被误报为打开成功");
  evidence.observations.lateChild = {
    leaseMatched: true, cancelPresent: true, startPresent: false,
    interactiveStartsBefore: interactiveStarts, interactiveStartsAfter: interactiveFakeStartCount(),
    phase: control.terminalState()?.phase ?? null,
  };
  evidence.timedOutLateChildCancelled = true;
  const handle = await lateWindowPromise;
  evidence.observations.lateChild.windowObserved = Boolean(handle);
  if (handle) await closeTracked(handle);
}

/** @param backend 期望后端 @returns 从真实按钮启动后的公开状态和窗口句柄 */
async function openFromSidepanel(backend) {
  const attempt = await beginSystemOpen();
  const state = await control.wait((message) => control.inbox.indexOf(message) >= attempt.messageStart
    && message.type === "terminal.state"
    && (message.state.phase === "active" || message.state.phase === "degraded" || message.state.phase === "idle"),
  `${backend} 启动状态`, 30000);
  if (state.state.phase === "idle") {
    const message = await evaluate(sidepanel, "document.querySelector('.terminal-error')?.textContent || ''");
    throw new Error(`${backend} 启动后回到 idle：${message || "无页面错误文本"}`);
  }
  assert(state.state.backend === backend, `实际后端不是 ${backend}`);
  const handle = (await findTerminalWindow(attempt.baseline, backend)).handle;
  trackTerminalConsole(handle, state.state.leaseId);
  return { state: state.state, handle, elapsedMs: Date.now() - attempt.clickedAt,
    errorAfterClick: attempt.errorAfterClick };
}

/** @param page 视图 @param kind compact/task/tools @returns 折叠与展开检查 */
async function fixtureState(page, kind) {
  return evaluate(page, `(() => {
    const list = document.querySelector('.message-list');
    if (!list) return null;
    const cards = [...list.querySelectorAll('.tool-card')];
    if (${JSON.stringify(kind)} === 'compact') {
      const card = cards.find(el => (el.textContent || '').includes('已压缩上下文') && (el.textContent || '').includes('INTERNAL_COMPACT_SUMMARY_COLLAPSED'));
      const detail = card?.querySelector('details.status-detail');
      return detail ? { open: detail.open, detail: detail.querySelector('pre')?.textContent || '',
        leakedUser: [...list.querySelectorAll('.msg.user')].some(el => (el.textContent || '').includes('INTERNAL_COMPACT_SUMMARY_COLLAPSED')) } : null;
    }
    if (${JSON.stringify(kind)} === 'task') {
      const card = cards.find(el => (el.textContent || '').includes('任务已完成：task-fixture'));
      const detail = card?.querySelector('details.status-detail');
      return detail ? { open: detail.open, detail: detail.querySelector('pre')?.textContent || '',
        leakedUser: [...list.querySelectorAll('.msg.user')].some(el => (el.textContent || '').includes('SUBAGENT_REPORT_START')) } : null;
    }
    const read = list.querySelector('.tool-activity[data-tool="Read"]');
    const edit = list.querySelector('.tool-activity[data-tool="Edit"]');
    const readDetails = read ? [...read.querySelectorAll('details')].map(el => ({ open: el.open, text: el.textContent || '' })) : [];
    const editDetails = edit ? [...edit.querySelectorAll('details')].map(el => ({ open: el.open, text: el.textContent || '' })) : [];
    const ask = list.querySelector('.interaction-record');
    if (!read || !edit || !ask) return null;
    return { readDetails, editDetails, ask: ask?.textContent || '' };
  })()`);
}

/** @returns 无返回值；逐项断言缺证据即非零 */
function assertRequiredEvidence() {
  const required = {
    windowsTerminalVisible: true, resumedInitialSession: true,
    clearFollowedNewSession: true, resumeFollowedSelectedSession: true,
    slowSystemOpenSucceeded: true, slowSystemOpenClearedStaleError: true, timedOutLateChildCancelled: true,
    fallbackConsoleVisible: true, fallbackReported: true,
    ordinaryExternalSessionListedWithoutTakeover: true, compactKeptSessionAndCollapsedSummary: true,
    taskReportCollapsed: true, sidepanelReadonly: true, popupReadonly: true,
    directWriteRequestsRejected: true, exitRestoredLastHookSession: true, degradedStayedReadonly: true,
    restartRecoveredSystemLease: true, unknownIdentityRequiredManualRelease: true,
    commandHooksWithoutFailure: true, compiledExeOutsideProjectTree: true, realApiCalled: false,
  };
  for (const [name, expected] of Object.entries(required)) {
    if (evidence[name] !== expected) throw new Error(`验收失败: ${name}，实际=${JSON.stringify(evidence[name])}`);
  }
  if (evidence.runtimeErrors.length !== 0) throw new Error("Chrome 存在运行错误");
}

async function run() {
  const projectDir = path.join(claudeConfig, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  seedTranscript(path.join(projectDir, `${INITIAL_SID}.jsonl`), "TERMINAL_INITIAL_SESSION");
  await startBridge(negativeControl === "hooks" ? { CCC_FAKE_CLI_DISABLE_HOOKS: "1" } : {});
  control.send({ type: "folder.bind", path: cwd, reset: true });
  await control.wait((message) => message.type === "folder.bound" && message.path === cwd, "绑定隔离文件夹");
  control.send({ type: "session.switch", sessionId: INITIAL_SID });
  const bound = await control.wait((message) => message.type === "folder.bound"
    && message.path === cwd && message.sessionId === INITIAL_SID, "选择预置初始会话");
  assert(bound.resumed === true, "预置初始会话未被识别为可续聊转录");
  await startChrome();
  await evaluate(sidepanel, `(() => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'DRAFT_BEFORE_TERMINAL');
    input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  })()`);
  await waitFor(() => popup && readReadonly(popup, false).then((state) => state.draft === "DRAFT_BEFORE_TERMINAL" ? true : null), "草稿同步双视图");

  if (!negativeControl) await verifyLateChildCancelled();
  fs.writeFileSync(wtDelayFile, negativeControl ? "0" : "6500", "utf8");
  const first = await openFromSidepanel("windows-terminal");
  if (!negativeControl) {
    const finalError = await evaluate(sidepanel, "document.querySelector('.terminal-error')?.textContent || ''");
    evidence.slowSystemOpenSucceeded = first.elapsedMs >= 6000 && first.elapsedMs < 20000
      && first.state.leaseId && fs.existsSync(path.join(home, "terminal", `${first.state.leaseId}.start`));
    evidence.slowSystemOpenClearedStaleError = first.errorAfterClick === "" && finalError === "";
    evidence.observations.slowSystemOpen = { elapsedMs: first.elapsedMs,
      errorAfterClick: first.errorAfterClick, finalError };
  }
  fs.writeFileSync(wtDelayFile, "0", "utf8");
  registerWtShims();
  const firstWindow = captureTerminal(first.handle, "windows-terminal-visible.png");
  evidence.windowsTerminalVisible = firstWindow.visible && firstWindow.width > 0 && firstWindow.height > 0;
  evidence.observations.windowsTerminal = { title: firstWindow.title, className: firstWindow.className, cwd };
  const initialStarts = fs.readFileSync(path.join(claudeConfig, "fake-cli-events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((event) => event.kind === "start" && event.resumeArg === INITIAL_SID);
  evidence.resumedInitialSession = first.state.initialSessionId === INITIAL_SID && initialStarts.length > 0;
  if (negativeControl === "hooks") {
    const degraded = await control.wait((message) => message.type === "terminal.state" && message.state.phase === "degraded", "负控降级", 15000);
    assert(degraded.state.currentSessionId === null || degraded.state.currentSessionId === INITIAL_SID, "负控不应猜出新会话");
    await verifyReadonly(true);
    evidence.degradedStayedReadonly = true;
    sendTracked(first.handle, "/clear");
    await delay(1000);
    evidence.clearFollowedNewSession = false;
    evidence.observations.negativeControl = "隔离假 CLI 禁用 Hooks；已观察到 degraded 与只读，后续会话跟随证据必须缺失";
    assertRequiredEvidence();
    return;
  }

  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.currentSessionId === INITIAL_SID, "初始 resume Hook");
  await verifyReadonly(true);

  const writes = [
    { type: "chat.send", text: "不得双写" }, { type: "chat.abort" }, { type: "session.new" },
    { type: "session.switch", sessionId: EXTERNAL_SID }, { type: "session.delete", sessionId: EXTERNAL_SID },
    { type: "folder.bind", path: cwd }, { type: "alias.select", id: "alias-1" }, { type: "alias.delete", id: "alias-1" },
    { type: "permission.response", requestId: "p1", allow: true },
    { type: "chat.ask.answer", requestId: "a1", answers: {} },
    { type: "settings.set", permissionMode: "plan", effort: "medium", fastMode: false },
  ];
  const errorsBefore = control.inbox.filter((message) => message.type === "terminal.error" && message.code === "READ_ONLY").length;
  for (const message of writes) control.send(message);
  await waitFor(() => control.inbox.filter((message) => message.type === "terminal.error"
    && message.code === "READ_ONLY").length === errorsBefore + writes.length ? true : null, "11 个 READ_ONLY");
  evidence.directWriteRequestsRejected = true;

  sendTracked(first.handle, "/clear");
  await delay(500);
  captureTerminal(first.handle, "after-clear-input.png");
  const cleared = await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.currentSessionId && message.state.currentSessionId !== INITIAL_SID, "/clear 新会话 Hook");
  const clearSid = cleared.state.currentSessionId;
  await waitFor(async () => (await evaluate(sidepanel, "document.querySelector('.message-list')?.textContent || ''")).includes("TERMINAL_CLEAR_CONFIRMED") ? true : null, "clear 镜像");
  evidence.clearFollowedNewSession = true;

  const emptySettings = path.join(toolsDir, "empty-settings.json");
  fs.writeFileSync(emptySettings, "{}", "utf8");
  const ordinary = spawn(FAKE_CLI, ["--session-id", EXTERNAL_SID, "--settings", emptySettings], {
    cwd, env: bridgeEnvironment, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  externalChildren.add(ordinary);
  await control.wait((message) => message.type === "session.list.data"
    && message.sessions.some((session) => session.sessionId === EXTERNAL_SID), "普通外部新会话进列表");
  assert(control.terminalState().currentSessionId === clearSid, "普通外部会话抢占 lease 镜像");
  assert(!(await evaluate(sidepanel, "document.querySelector('.message-list')?.textContent || ''")).includes("TERMINAL_SESSION_STARTED\nTERMINAL_SESSION_STARTED"), "外部会话内容进入当前镜像");
  evidence.ordinaryExternalSessionListedWithoutTakeover = true;
  ordinary.stdin.write("exit\n");
  await new Promise((resolve) => ordinary.once("exit", resolve));
  externalChildren.delete(ordinary);

  sendTracked(first.handle, `/resume ${INITIAL_SID}`);
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.currentSessionId === INITIAL_SID, "/resume 指定会话 Hook");
  await waitFor(async () => (await evaluate(popup, "document.querySelector('.message-list')?.textContent || ''")).includes("TERMINAL_RESUME_CONFIRMED") ? true : null, "resume 双视图镜像");
  evidence.resumeFollowedSelectedSession = true;

  sendTracked(first.handle, "/fork");
  const forked = await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.currentSessionId && message.state.currentSessionId !== INITIAL_SID
    && message.state.currentSessionId !== clearSid, "fork Hook");
  const activeSid = forked.state.currentSessionId;
  evidence.observations.sessionTransitions = { clearSid, activeSid,
    forkFollowedNewSession: activeSid !== clearSid };
  evidence.observations.forkFollowedNewSession = activeSid !== clearSid;

  sendTracked(first.handle, "/compact");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.currentSessionId === activeSid, "compact 保持会话");
  for (const page of [sidepanel, popup]) {
    const state = await waitFor(() => fixtureState(page, "compact"), "compact 折叠详情");
    assert(state.open === false && state.detail.includes("完整内部摘要") && !state.leakedUser, "compact 摘要角色或折叠错误");
    evidence.compactKeptSessionAndCollapsedSummary = control.terminalState().currentSessionId === activeSid;
    evidence.observations.compactState = { activeSid,
      currentSessionId: control.terminalState()?.currentSessionId ?? null };
  }

  sendTracked(first.handle, "/fixture task");
  for (const page of [sidepanel, popup]) {
    const state = await waitFor(() => fixtureState(page, "task"), "Task 折叠报告");
    assert(state.open === false && state.detail.includes("SUBAGENT_REPORT_START")
      && state.detail.includes("SUBAGENT_REPORT_END") && !state.leakedUser, "Task 长报告未默认折叠或冒充用户");
    const expanded = await evaluate(page, `(() => {
      const card = [...document.querySelectorAll('.tool-card')].find(el => (el.textContent || '').includes('任务已完成：task-fixture'));
      const detail = card?.querySelector('details.status-detail'); if (!detail) return false;
      detail.querySelector('summary').click(); return detail.open;
    })()`);
    assert(expanded, "Task 完整报告不能展开");
  }
  evidence.taskReportCollapsed = true;

  sendTracked(first.handle, "/fixture tools");
  const toolState = await waitFor(() => fixtureState(sidepanel, "tools"), "工具/diff/Ask 夹具");
  evidence.observations.toolState = toolState;
  await screenshot(sidepanel, "sidepanel-tools-debug.png");
  assert(toolState.readDetails.length === 2 && toolState.readDetails.every((item) => !item.open)
    && toolState.readDetails.some((item) => item.text.includes("COMPLETE_TOOL_OUTPUT")), "工具完整输出未折叠");
  assert(toolState.editDetails.some((item) => item.text.includes("-旧行") && item.text.includes("+新行")), "Edit diff 丢失");
  assert(toolState.ask.includes("选哪个？") && toolState.ask.includes("A"), "Ask 历史结果丢失");
  await screenshot(sidepanel, "sidepanel-readonly-fixtures.png");
  await screenshot(popup, "popup-readonly-fixtures.png");

  const recoveredLease = control.terminalState().leaseId;
  await stopBridge();
  await startBridge();
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === recoveredLease && message.state.currentSessionId === activeSid, "重启恢复活动 lease");
  await Promise.all([waitConnected(sidepanel, "side panel 重启重连"), waitConnected(popup, "popup 重启重连")]);
  await verifyReadonly(true);
  evidence.restartRecoveredSystemLease = true;

  const exitFrom = control.inbox.length;
  sendTracked(first.handle, "exit");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "idle", "真实退出 idle");
  const tail = control.inbox.slice(exitFrom);
  const mirrorIndex = tail.map((message) => message.type === "session.mirror.data").lastIndexOf(true);
  const restoreIndex = tail.map((message) => message.type === "folder.bound" && message.sessionId === activeSid).lastIndexOf(true);
  const idleIndex = tail.map((message) => message.type === "terminal.state" && message.state.phase === "idle").lastIndexOf(true);
  assert(mirrorIndex >= 0 && restoreIndex > mirrorIndex && idleIndex > restoreIndex, "最终镜像/恢复/idle 顺序错误");
  await verifyReadonly(false);
  evidence.exitRestoredLastHookSession = true;

  await stopBridge();
  await startBridge({ CCC_FAKE_CLI_DISABLE_HOOKS: "1" });
  control.send({ type: "terminal.open", mode: "system" });
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "degraded", "无 Hook 10 秒降级", 20000);
  await verifyReadonly(true);
  evidence.degradedStayedReadonly = true;
  const degradedLease = control.terminalState().leaseId;
  const degradedCloseFrom = control.inbox.length;
  control.send({ type: "terminal.close", leaseId: degradedLease });
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "idle"
    && control.inbox.indexOf(message) >= degradedCloseFrom, "关闭降级终端后的新 idle");

  await stopBridge();
  await startBridge();
  const unknownInitialState = control.terminalState();
  const unknownMessageStart = control.inbox.length;
  control.send({ type: "terminal.open", mode: "system" });
  const unknownBaseline = new Set(listWindows().map((item) => item.handle));
  await delay(1000);
  evidence.observations.unknownMessages = control.inbox.slice(unknownMessageStart)
    .filter((message) => message.type.startsWith("terminal.") || message.type === "folder.bound")
    .map((message) => ({
      type: message.type,
      phase: message.state?.phase,
      leaseId: message.state?.leaseId ?? message.leaseId,
      code: message.code,
      error: message.message,
      folder: message.path,
    }));
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId !== degradedLease, "unknown 场景新活动 lease");
  const unknownLease = control.terminalState().leaseId;
  evidence.observations.unknownOpen = {
    initialPhase: unknownInitialState?.phase ?? null,
    leaseId: unknownLease,
    distinctFromDegraded: unknownLease !== degradedLease,
    privateFiles: fs.readdirSync(path.join(home, "terminal")).filter((name) => name.startsWith(`${unknownLease}.`)),
  };
  const unknownHandle = (await findTerminalWindow(unknownBaseline, "windows-terminal")).handle;
  trackTerminalConsole(unknownHandle, unknownLease);
  await stopBridge();
  const leaseFile = path.join(home, "terminal", "system-lease.json");
  const privateRecord = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  privateRecord.identity.startedAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(leaseFile, JSON.stringify(privateRecord, null, 2), { encoding: "utf8", mode: 0o600 });
  await startBridge();
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "degraded"
    && message.state.canManualRelease === true && message.state.leaseId === unknownLease, "身份 unknown 人工解除状态");
  await verifyReadonly(true);
  const stopFile = path.join(home, "terminal", `${unknownLease}.stop`);
  control.send({ type: "terminal.release", leaseId: unknownLease, confirmedClosed: true });
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "idle", "人工解除恢复输入");
  assert(!fs.existsSync(stopFile), "人工解除不得写 stop 文件或杀进程");
  evidence.unknownIdentityRequiredManualRelease = true;
  // 人工解除后 Hook 端点已不存在；不能再让假 CLI 走 SessionEnd，直接关闭该隔离窗口。
  await closeTracked(unknownHandle);

  await stopBridge();
  await startBridge({ PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0" });
  await Promise.all([waitConnected(sidepanel, "回退前 side panel 重连"), waitConnected(popup, "回退前 popup 重连")]);
  const fallback = await openFromSidepanel("windows-console");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active", "回退控制台 Hook");
  await waitFor(async () => (await evaluate(sidepanel, "document.querySelector('.terminal-notice')?.textContent || ''")).includes("已回退到系统控制台") ? true : null, "UI 回退提示");
  evidence.fallbackReported = true;
  const fallbackWindow = captureTerminal(fallback.handle, "fallback-console-visible.png");
  evidence.fallbackConsoleVisible = fallbackWindow.visible && fallbackWindow.width > 0 && fallbackWindow.height > 0;
  evidence.observations.fallbackConsole = { title: fallbackWindow.title, className: fallbackWindow.className, cwd };
  sendTracked(fallback.handle, "exit");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "idle", "回退终端退出");

  evidence.runtimeErrors = pages.flatMap((page) => page.errors.map((error) => ({ page: page.label, error })));
  const eventFile = path.join(claudeConfig, "fake-cli-events.jsonl");
  const hookFailures = fs.existsSync(eventFile)
    ? fs.readFileSync(eventFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.kind === "hook-helper-stderr" || event.kind === "hook-error")
    : [{ kind: "missing-event-log" }];
  evidence.observations.hookFailures = hookFailures;
  evidence.commandHooksWithoutFailure = hookFailures.length === 0;
  evidence.observations.upstream = { loopbackRequests: upstreamRequests, realApiCalled: false };
  assertRequiredEvidence();
  evidence.ok = true;
  saveEvidence();
}

try {
  await run();
} catch (error) {
  evidence.ok = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.runtimeErrors = pages.flatMap((page) => page.errors.map((item) => ({ page: page.label, error: item })));
  saveEvidence();
  console.error(`SYSTEM_TERMINAL_VERIFICATION_ERROR=${evidence.error}`);
  process.exitCode = 1;
} finally {
  saveEvidence();
  const cleanupErrors = [];
  try {
    // 仅清理本脚本隔离私有目录中的 lease；不读取或停止用户桥接/终端。
    const leaseFile = path.join(home, "terminal", "system-lease.json");
    if (fs.existsSync(leaseFile)) {
      const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
      if (lease.mode === "system" && typeof lease.leaseId === "string" && inside(home, lease.privateDir)) {
        fs.writeFileSync(path.join(lease.privateDir, `${lease.leaseId}.stop`), "", { encoding: "utf8", mode: 0o600 });
      }
    }
  } catch {}
  for (const child of externalChildren) if (child.exitCode === null && child.signalCode === null) child.kill();
  const visibleBeforeClose = listWindows();
  for (const handle of [...terminalWindows]) {
    if (!visibleBeforeClose.some((item) => item.handle === String(handle))) {
      terminalWindows.delete(handle);
      terminalConsolePids.delete(handle);
      continue;
    }
    try { await closeTracked(handle); } catch (error) { cleanupErrors.push(`terminal window: ${error.message}`); }
  }
  if (browserCdp) { try { await browserCdp.send("Browser.close"); } catch {} }
  await delay(500);
  if (chromeChild && chromeChild.exitCode === null && chromeChild.signalCode === null) chromeChild.kill();
  try { await stopBridge(); } catch (error) { cleanupErrors.push(`bridge: ${error.message}`); }
  if (control) control.close();
  registerWtShims();
  const remaining = [];
  for (const [pid, owned] of ownedProcesses) {
    const actual = processIdentity(pid);
    if (!actual) continue;
    const same = actual.executable.toLowerCase() === owned.executable.toLowerCase()
      && Date.parse(actual.startedAt) === Date.parse(owned.startedAt);
    if (!same) {
      remaining.push({ pid, role: owned.role, reason: "identity-mismatch-not-killed" });
      continue;
    }
    try { process.kill(pid); } catch {}
  }
  await delay(500);
  for (const [pid, owned] of ownedProcesses) {
    if (pidAlive(pid)) remaining.push({ pid, role: owned.role, reason: "still-alive" });
  }
  for (const child of externalChildren) {
    if (child.exitCode === null && child.signalCode === null) remaining.push({ pid: child.pid, role: "direct-child" });
  }
  if (chromeChild && chromeChild.exitCode === null && chromeChild.signalCode === null) {
    remaining.push({ pid: chromeChild.pid, role: "chrome" });
  }
  for (const handle of terminalWindows) remaining.push({ handle: String(handle), role: "terminal-window" });
  await new Promise((resolve) => upstream.close(resolve));
  evidence.observations.cleanup = { remaining, errors: cleanupErrors };
  if (remaining.length || cleanupErrors.length) {
    evidence.ok = false;
    process.exitCode = 1;
    evidence.error = `${evidence.error ? `${evidence.error}; ` : ""}定向清理复核失败`;
  }
  saveEvidence();
  if (evidence.ok) console.log(`SYSTEM_TERMINAL_VERIFICATION_OK=${resultFile}`);
}
