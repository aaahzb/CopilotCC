/**
 * 阶段 B/C 双终端端到端验收：完整发行目录或绿色单文件 + 真实 Chrome/xterm + 真实 PTY + 隔离假 CLI。
 * 用法：node bridge/scripts/verify-embedded-terminal.mjs --root <已批准根目录下的新目录> [--portable] [--negative-control attach]
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { resolveRealCli, runRealCli, startRealCliUpstream } from "./real-cli-test-fixture.mjs";

const APPROVED_ROOT = "D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_PATH = path.join(PROJECT_ROOT, "extension", ".output", "chrome-mv3");
const DIST_DIR = path.join(PROJECT_ROOT, "bridge", "dist", "ccc-bridge-win-x64");
const DIST_EXE = path.join(DIST_DIR, "ccc-bridge.exe");
const DIST_TERMINAL_EXE = path.join(DIST_DIR, "ccc-terminal.exe");
const PORTABLE_EXE = path.join(PROJECT_ROOT, "bridge", "dist", "portable-win-x64", "CopilotCC.exe");
const FAKE_CLI = path.join(APPROVED_ROOT, "bin", "fake-claude.exe");
const EXTENSION_ID = "cnalihjaacpahpjkpneacjcfbhboglno";
const PAGE_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;
const TERMINAL_PAGE_URL = `chrome-extension://${EXTENSION_ID}/terminal.html`;
const INITIAL_SID = "11111111-1111-4111-8111-111111111111";
const EXTERNAL_SID = "22222222-2222-4222-8222-222222222222";
const token = randomBytes(24).toString("base64url");
const realCliResumeOnly = process.argv.includes("--real-cli-resume-only");
const portable = process.argv.includes("--portable");
const realCliPath = realCliResumeOnly ? resolveRealCli() : null;
const REAL_MARKERS = {
  initialUser: "REAL_CLI_ORIGINAL_USER",
  initialAssistant: "REAL_CLI_ORIGINAL_ASSISTANT",
  embeddedUser: "REAL_CLI_EMBEDDED_USER",
  embeddedAssistant: `REAL_CLI_EMBEDDED_ASSISTANT ${"SCROLLBACK_CONTEXT_".repeat(1200)}`,
  systemUser: "REAL_CLI_SYSTEM_USER",
  systemAssistant: "REAL_CLI_SYSTEM_ASSISTANT",
  interruptUser: "REAL_CLI_INTERRUPT_USER",
};
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
assert(root && inside(APPROVED_ROOT, root), "root 必须严格位于批准的 dual-terminal-20261110 目录内");
assert(!negativeControl || negativeControl === "attach", "仅支持 --negative-control attach");
assert(!(realCliResumeOnly && negativeControl), "真实 CLI 补验不能与 attach 负控同时使用");
if (fs.existsSync(root)) assert(fs.readdirSync(root).length === 0, "root 必须为空；不覆盖或删除旧证据");
const home = path.join(root, "home");
const claudeConfig = path.join(root, "claude-config");
const cwd = path.join(root, "cwd");
const binDir = path.join(root, "bin");
const toolsDir = path.join(root, "tools");
const appDir = path.join(root, "app");
for (const dir of [root, home, claudeConfig, cwd, binDir, toolsDir, appDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const dir of [home, claudeConfig, cwd, appDir]) assert(inside(root, dir), "隔离路径越出 root");
process.chdir(cwd);
assert(!inside(PROJECT_ROOT, process.cwd()) && path.resolve(process.cwd()) !== PROJECT_ROOT, "验收 CWD 不得位于项目树内");
assert(process.platform === "win32", "本脚本当前只执行真实 Windows 验收");
for (const file of [DIST_EXE, DIST_TERMINAL_EXE, FAKE_CLI, path.join(DIST_DIR, "pty-manifest.json"),
  path.join(EXTENSION_PATH, "manifest.json"), path.join(EXTENSION_PATH, "terminal.html"),
  ...(portable ? [PORTABLE_EXE] : [])]) {
  assert(fs.existsSync(file), `缺少验收产物：${file}`);
}
// 正常 portable 路径只复制一个 exe；完整目录仍用于旧布局和独立缺 manifest 故障注入。
if (portable) fs.copyFileSync(PORTABLE_EXE, path.join(appDir, "CopilotCC.exe"), fs.constants.COPYFILE_EXCL);
else fs.cpSync(DIST_DIR, appDir, { recursive: true, force: false, errorOnExist: true });
const isolatedExe = path.join(appDir, portable ? "CopilotCC.exe" : "ccc-bridge.exe");
const isolatedTerminalExe = path.join(appDir, "ccc-terminal.exe");
const isolatedFakeCli = path.join(binDir, "fake-claude.exe");
const sourceManifestHash = createHash("sha256").update(fs.readFileSync(path.join(DIST_DIR, "pty-manifest.json"))).digest("hex");
let manifestHash = portable ? null : sourceManifestHash;

const evidence = {
  terminalWindowVisible: false,
  terminalWindowDeduped: false,
  authenticatedBeforeOpen: false,
  attachedAfterOpenedOnSameConnection: false,
  resumedCorrectSession: false,
  inputAndContinuousOutput: false,
  chineseInputOutput: false,
  imeCompositionNotDuplicated: false,
  terminalToolbarVisible: false,
  realClipboardMultilineCopy: false,
  ctrlCCopiesSelection: false,
  ctrlShiftCCopiesSelection: false,
  buttonPasteMultilineChinese: false,
  ctrlShiftVPasteMultilineChinese: false,
  resizedPtyTo132x36: false,
  sidepanelAndChatPopupReadonly: false,
  jsonlMirrorNotAnsiParsed: false,
  clearResumeForkFollowedHooks: false,
  noSessionUsesGeneratedUuid: false,
  compactAndTaskCollapsedExpandable: false,
  ordinaryExternalSessionListedWithoutTakeover: false,
  directWritesRejected: false,
  nonOwnerControlsRejected: false,
  replayContiguous: false,
  reconnectWithin3Seconds: false,
  reconnectAfter3SecondsKillsOwnedPty: false,
  refreshCannotReuseAttachToken: false,
  outputGapVisibleAndCloses: false,
  closeButtonRestoresLastHookSession: false,
  chatDisconnectDoesNotKillPty: false,
  pagehideClosesOwnedPty: false,
  bridgeShutdownKillsOwnedPty: false,
  abnormalRestartClearsExitedConpty: false,
  matchedIdentityRecoveryKillsOnlyOwnedPty: false,
  abnormalRestartNeverKillsUnknownIdentity: false,
  nativeFailureLeavesChatAndSystemTerminalUsable: false,
  systemAndEmbeddedMutuallyExclusive: false,
  commandHooksWithoutFailure: false,
  portableSingleFileOnly: portable ? fs.readdirSync(appDir).length === 1
    && fs.readdirSync(appDir)[0] === "CopilotCC.exe" : null,
  portableRuntimeIdentity: portable ? false : null,
  portableGracefulShutdown: portable ? false : null,
  compiledExeOutsideProjectTree: inside(APPROVED_ROOT, isolatedExe) && !inside(PROJECT_ROOT, isolatedExe),
  realApiCalled: false,
  macOSVerified: false,
  runtimeErrors: [],
  negativeControl,
  observations: { manifestHash, portable, cleanup: { remaining: [] } },
  unverifiedPlatforms: { macos: "未在 macOS arm64 运行，Terminal.app、原生 PTY 与签名尚未验收" },
};
let bridgeChild = null;
let bridgePid = null;
let bridgeExecutable = null;
let bridgeTray = null;
let bridgeLaunchPortable = false;
let lastPortableBridgePid = null;
let chromeChild = null;
let browserCdp = null;
let control = null;
let runtimePort = 0;
let bridgeEnvironment = null;
let upstreamRequests = 0;
let proxy = null;
let realUpstream = null;
let realInterruptUpstream = null;
let setupPage = null;
let terminalPage = null;
let terminalTargetId = null;
const externalChildren = new Set();
const bridgeChildren = new Set();
const ownedProcesses = new Map();
const ownedChromeWindowIds = new Set();
const pages = [];
const terminalWindows = new Set();
const terminalConsolePids = new Map();
const resultFile = negativeControl ? path.join(root, "red-result.json") : path.join(root, "embedded-verification.json");

/** @param value 待记录文本 @returns 清除配对串和查询 token 后的文本 */
function redact(value) {
  return String(value).split(token).join("[redacted]")
    .replace(/([?&]token=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/("(?:attachToken|hookToken|Authorization)"\s*:\s*")[^"]+/gi, "$1[redacted]");
}

/** @returns 无返回值；只写不含 token/环境的结果 JSON */
function saveEvidence() {
  if (realUpstream) evidence.observations.realCliRequests = realUpstream.requests;
  evidence.observations.terminalInputs = proxy.events.filter((event) => event.pasteMarker || event.inputKind);
  fs.writeFileSync(resultFile, redact(JSON.stringify(evidence, null, 2)), "utf8");
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
using System.IO;
using System.Management;
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
  public class TrayInfo {
    public int pid;
    public int parentPid;
    public string executable;
    public string startedAt;
    public string startTicks;
    public string window;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct KEY_EVENT_RECORD {
    public int KeyDown; public ushort RepeatCount, VirtualKeyCode, VirtualScanCode;
    public char UnicodeChar; public uint ControlKeyState;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct INPUT_RECORD {
    public ushort EventType; public KEY_EVENT_RECORD KeyEvent;
  }
  private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr extra);
  private delegate bool ConsoleCtrlDelegate(uint ctrlType);
  private static string targetSignalFile = "";
  private static bool TargetConsoleCtrl(uint ctrlType) {
    File.WriteAllText(targetSignalFile, "CTRL:" + ctrlType);
    Environment.Exit(0);
    return true;
  }
  private static readonly ConsoleCtrlDelegate RecordConsoleCtrl = TargetConsoleCtrl;
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError=true)] static extern int GetConsoleProcessList(uint[] processes, int count);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handler, bool add);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern short VkKeyScan(char character);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(
    IntPtr handle, int index, StringBuilder info, int length, out uint needed);
  [DllImport("kernel32.dll", EntryPoint="WriteConsoleInputW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WriteConsoleInput(
    IntPtr input, INPUT_RECORD[] records, uint length, out uint written);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(
    string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string currentDirectory,
    ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInfo);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

  static PROCESS_INFORMATION StartConsole(string executable, string workingDirectory, string arguments) {
    var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup);
    var command = new StringBuilder("\"" + executable + "\" " + arguments);
    PROCESS_INFORMATION process;
    // 独占新 Console：只向该 Console 广播；不创建默认禁用 Ctrl+C 的新进程组。
    if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0x10 | 0x400,
      IntPtr.Zero, workingDirectory, ref startup, out process)) {
      int error = Marshal.GetLastWin32Error();
      throw new System.ComponentModel.Win32Exception(error, "CreateProcess(console) failed: " + error);
    }
    CloseHandle(process.hThread);
    return process;
  }

  static int StartConsoleAndWait(string executable, string workingDirectory, string arguments) {
    var process = StartConsole(executable, workingDirectory, arguments);
    try {
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { pid=process.dwProcessId }));
      Console.Out.Flush();
      WaitForSingleObject(process.hProcess, 0xffffffff);
      uint exitCode;
      if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return unchecked((int)exitCode);
    } finally { CloseHandle(process.hProcess); }
  }

  static int SignalTarget(string readyFile, string signalFile) {
    Console.TreatControlCAsInput = false;
    Console.WriteLine("signal-target");
    Console.Out.Flush();
    targetSignalFile = signalFile;
    SetConsoleCtrlHandler(RecordConsoleCtrl, true);
    Console.CancelKeyPress += (sender, args) => {
      args.Cancel = true;
      File.WriteAllText(signalFile, "SIGINT");
      Environment.Exit(0);
    };
    File.WriteAllText(readyFile, "ready");
    while (true) Thread.Sleep(1000);
  }

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

  static string ObjectName(IntPtr handle) {
    if (handle == IntPtr.Zero) return "ERROR:" + Marshal.GetLastWin32Error();
    var name = new StringBuilder(256);
    uint needed;
    if (!GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed)) {
      return "ERROR:" + Marshal.GetLastWin32Error();
    }
    return name.ToString();
  }

  static string DesktopInfo() {
    var input = OpenInputDesktop(0, false, 0x0001);
    try {
      return new JavaScriptSerializer().Serialize(new {
        windowStation=ObjectName(GetProcessWindowStation()),
        threadDesktop=ObjectName(GetThreadDesktop(GetCurrentThreadId())),
        inputDesktop=ObjectName(input),
        foreground=GetForegroundWindow().ToInt64().ToString(),
      });
    } finally { if (input != IntPtr.Zero) CloseHandle(input); }
  }

  static string CloseConsole(uint pid, uint verifierPid) {
    FreeConsole();
    IntPtr consoleWindow;
    try {
      if (!AttachConsole(pid)) {
        int error = Marshal.GetLastWin32Error();
        throw new System.ComponentModel.Win32Exception(error, "AttachConsole(close) failed: " + error);
      }
      var buffer = new uint[64];
      int count = GetConsoleProcessList(buffer, buffer.Length);
      if (count <= 0 || count > buffer.Length) throw new Exception("GetConsoleProcessList(close) failed: " + count);
      var attached = new List<uint>();
      for (int i = 0; i < count; i++) attached.Add(buffer[i]);
      if (!attached.Contains(pid) || attached.Contains(verifierPid)) {
        throw new Exception("Unsafe console ownership for WM_CLOSE: target=" + pid + ", verifier=" + verifierPid);
      }
      consoleWindow = GetConsoleWindow();
      if (consoleWindow == IntPtr.Zero) throw new Exception("GetConsoleWindow(close) returned zero");
    } finally { FreeConsole(); }
    // 先脱离目标 Console，再仅向已核对的隔离 Console 窗口请求正常关闭。
    if (!PostMessage(consoleWindow, 0x0010, IntPtr.Zero, IntPtr.Zero)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "PostMessage(console WM_CLOSE) failed");
    }
    return new JavaScriptSerializer().Serialize(new { sent=true, consolePid=pid, isolatedConsole=true, target=consoleWindow.ToInt64().ToString() });
  }

  static IntPtr UniqueTrayWindow(int pid) {
    var matches = new List<IntPtr>();
    EnumWindows((hwnd, extra) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner == (uint)pid && !IsWindowVisible(hwnd) && Text(hwnd, true) == "SystrayClass") {
        matches.Add(hwnd);
      }
      return true;
    }, IntPtr.Zero);
    if (matches.Count != 1) throw new InvalidOperationException("expected exactly one hidden SystrayClass window, got " + matches.Count);
    return matches[0];
  }

  static TrayInfo FindTray(uint bridgePid, string expectedPath) {
    string fullExpected = Path.GetFullPath(expectedPath);
    int matches = 0;
    int trayPid = 0;
    using (var searcher = new ManagementObjectSearcher(
      "SELECT ProcessId, ParentProcessId, ExecutablePath FROM Win32_Process WHERE Name = 'tray_windows_release.exe'")) {
      foreach (ManagementObject item in searcher.Get()) {
        using (item) {
          if (Convert.ToUInt32(item["ParentProcessId"]) != bridgePid) continue;
          string candidate = Convert.ToString(item["ExecutablePath"]);
          if (candidate.Length == 0 || !String.Equals(Path.GetFullPath(candidate), fullExpected,
            StringComparison.OrdinalIgnoreCase)) continue;
          matches++;
          trayPid = Convert.ToInt32(item["ProcessId"]);
        }
      }
    }
    if (matches != 1) throw new InvalidOperationException("expected exactly one owned tray helper, got " + matches);
    using (var process = Process.GetProcessById(trayPid)) {
      string executable = Path.GetFullPath(process.MainModule.FileName);
      if (!String.Equals(executable, fullExpected, StringComparison.OrdinalIgnoreCase)) {
        throw new InvalidOperationException("tray executable path mismatch");
      }
      DateTime started = process.StartTime.ToUniversalTime();
      return new TrayInfo {
        pid=trayPid, parentPid=(int)bridgePid, executable=executable.Replace('\\', '/'),
        startedAt=started.ToString("o"), startTicks=started.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
        window=UniqueTrayWindow(trayPid).ToInt64().ToString(),
      };
    }
  }

  static string ExitTray(uint bridgePid, int trayPid, string expectedPath, string startTicks) {
    var tray = FindTray(bridgePid, expectedPath);
    // systray v1.1.0 按菜单创建顺序分配 ID：状态/配对/端口/separator/退出 = 1/2/3/4/5。
    const int exitCommand = 5;
    if (tray.pid != trayPid || tray.startTicks != startTicks) {
      throw new InvalidOperationException("tray identity changed before WM_COMMAND");
    }
    var window = new IntPtr(long.Parse(tray.window));
    if (!PostMessage(window, 0x0111, new IntPtr(exitCommand), IntPtr.Zero)) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "PostMessage(tray exit) failed");
    }
    return new JavaScriptSerializer().Serialize(new { sent=true, command=exitCommand, tray });
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
    if (args.Length == 1 && args[0] == "desktop") {
      Console.Write(DesktopInfo()); return 0;
    }
    if (args.Length == 1 && args[0] == "list") {
      Console.Write(new JavaScriptSerializer().Serialize(List())); return 0;
    }
    if ((args.Length == 3 || args.Length == 4) && args[0] == "console-start-wait") {
      return StartConsoleAndWait(args[1], args[2], args.Length == 4 ? args[3] : "start");
    }
    if (args.Length == 3 && args[0] == "signal-target") return SignalTarget(args[1], args[2]);
    if (args.Length < 2) return 2;
    if (args[0] == "console-send" && args.Length == 3) {
      Console.Write(SendConsole(uint.Parse(args[1]), args[2])); return 0;
    }
    if (args[0] == "console-close" && args.Length == 3) {
      Console.Write(CloseConsole(uint.Parse(args[1]), uint.Parse(args[2]))); return 0;
    }
    if (args[0] == "tray-find" && args.Length == 3) {
      Console.Write(new JavaScriptSerializer().Serialize(FindTray(uint.Parse(args[1]), args[2]))); return 0;
    }
    if (args[0] == "tray-exit" && args.Length == 5) {
      Console.Write(ExitTray(uint.Parse(args[1]), int.Parse(args[2]), args[3], args[4])); return 0;
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
      Log("child-started", "pid=" + child.Id);
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

const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const windowSource = path.join(toolsDir, "WindowProbe.cs");
const windowProbe = path.join(toolsDir, "WindowProbe.exe");
fs.writeFileSync(windowSource, WINDOW_PROBE_SOURCE, "utf8");
const compile = spawnSync(csc, ["/nologo", "/target:exe", `/out:${windowProbe}`,
  "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll", "/reference:System.Web.Extensions.dll", "/reference:System.Management.dll", windowSource], {
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

const OUTPUT_MARKERS = [
  { name: "ascii-echo", needle: "FAKE_ECHO: hello embedded" },
  { name: "chinese-echo", needle: "FAKE_ECHO: 中文输入" },
  { name: "ime-echo", needle: "FAKE_ECHO: 组合输入" },
  { name: "button-paste-a", needle: "FAKE_ECHO: 粘贴第一行" },
  { name: "button-paste-b", needle: "FAKE_ECHO: 粘贴第二行" },
  { name: "shortcut-paste-a", needle: "FAKE_ECHO: 快捷粘贴甲" },
  { name: "shortcut-paste-b", needle: "FAKE_ECHO: 快捷粘贴乙" },
  { name: "tick-3", needle: "TICK:3" },
];
const MAX_OUTPUT_MARKER_LENGTH = Math.max(...OUTPUT_MARKERS.map((item) => item.needle.length));

/** 验收专用本机 WS 代理：记录脱敏帧元数据，并可精确制造断线/缺帧。 */
class VerificationProxy {
  /** @returns 已监听随机回环端口的代理 */
  static async listen() {
    const instance = new VerificationProxy();
    instance.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    instance.server.on("connection", (socket, request) => instance.accept(socket, request));
    await new Promise((resolve, reject) => {
      instance.server.once("listening", resolve);
      instance.server.once("error", reject);
    });
    instance.port = instance.server.address().port;
    return instance;
  }

  constructor() {
    this.connections = new Map();
    this.events = [];
    this.nextConnectionId = 1;
    this.dropFirstAttach = negativeControl === "attach";
    this.rejectConnections = false;
    this.dropNextOutput = false;
    this.droppedAttach = 0;
    this.droppedOutputSeq = null;
  }

  /** @param item 脱敏事件 @returns 无返回值 */
  record(item) {
    this.events.push({ at: Date.now(), ...item });
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
  }

  /** @param socket 浏览器连接 @param request HTTP upgrade @returns 无返回值 */
  accept(socket, request) {
    const id = this.nextConnectionId++;
    if (this.rejectConnections) {
      this.record({ connectionId: id, direction: "proxy", type: "connection.rejected" });
      socket.close(1013, "verification reconnect hold");
      return;
    }
    const query = new URL(request.url ?? "/ws", "http://127.0.0.1").search;
    const upstream = new WebSocket(`ws://127.0.0.1:${runtimePort}/ws${query}`);
    const meta = { id, socket, upstream, terminal: false, attached: false, leaseId: null, pending: [], outputTail: "", markers: new Set(), sizeReportKeys: new Set() };
    this.connections.set(id, meta);
    this.record({ connectionId: id, direction: "proxy", type: "connection" });
    upstream.on("open", () => {
      for (const data of meta.pending.splice(0)) upstream.send(data);
    });
    socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { socket.close(1003); return; }
      if (message.type === "terminal.open" && message.mode === "embedded") meta.terminal = true;
      this.record({ connectionId: id, direction: "client", type: message.type,
        ...(message.leaseId ? { leaseId: message.leaseId } : {}),
        ...(realCliResumeOnly && message.type === "terminal.input" ? {
          inputKind: message.data === "\r" ? "enter-cr" : message.data === "\n" ? "enter-lf"
            : message.data === "\x0f" ? "ctrl-o" : message.data === "[" ? "history-export-bracket"
              : message.data === "\x03" ? "ctrl-c"
                : message.data === "\x1b[A\x1b[A\x1b[A" ? "history-wheel-up"
                  : message.data === "\x1b[B\x1b[B\x1b[B" ? "history-wheel-down"
                    : message.data === "\x1b[A" || message.data === "\x1bOA" ? "arrow-up"
                      : message.data === "\x1b[B" || message.data === "\x1bOB" ? "arrow-down" : `length-${message.data?.length ?? 0}`,
        } : {}),
        ...(Number.isSafeInteger(message.afterSeq) ? { afterSeq: message.afterSeq } : {}),
        ...(message.type === "terminal.input" && typeof message.data === "string"
          && (message.data.includes("粘贴第一行") || message.data.includes("快捷粘贴甲")) ? {
            pasteMarker: message.data.includes("粘贴第一行") ? "button-multiline" : "shortcut-multiline",
            bracketed: message.data.startsWith("\x1b[200~") && message.data.endsWith("\x1b[201~"),
            hasFirstLine: true,
            hasSecondLine: message.data.includes("粘贴第二行") || message.data.includes("快捷粘贴乙"),
            carriageReturns: (message.data.match(/\r/g) ?? []).length,
            lineFeeds: (message.data.match(/\n/g) ?? []).length,
          } : {}),
        ...(Number.isInteger(message.cols) ? { cols: message.cols, rows: message.rows } : {}) });
      if (message.type === "terminal.attach") {
        meta.terminal = true;
        meta.leaseId = message.leaseId;
        if (this.dropFirstAttach) {
          this.dropFirstAttach = false;
          this.droppedAttach += 1;
          this.record({ connectionId: id, direction: "proxy", type: "attach.dropped" });
          return;
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(String(data));
      else meta.pending.push(String(data));
    });
    upstream.on("message", (data) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { socket.close(1003); return; }
      if (message.type === "terminal.opened" && message.mode === "embedded") {
        meta.terminal = true;
        meta.leaseId = message.leaseId;
      }
      if (message.type === "terminal.attached") meta.attached = true;
      if (message.type === "terminal.output" && typeof message.data === "string") {
        // 只保留跨块匹配所需的短尾；证据文件只出现固定标记名，不出现原始终端内容。
        const text = `${meta.outputTail}${message.data}`;
        for (const marker of OUTPUT_MARKERS) {
          if (!meta.markers.has(marker.name) && text.includes(marker.needle)) {
            meta.markers.add(marker.name);
            this.record({ connectionId: id, direction: "proxy", type: "output.marker",
              marker: marker.name, ...(Number.isSafeInteger(message.seq) ? { seq: message.seq } : {}) });
          }
        }
        for (const [type, pattern] of [["pty.size", /(?<!RE)SIZE:(\d+)x(\d+)/g],
          ["pty.resize", /RESIZE:(\d+)x(\d+)/g]]) {
          for (const match of text.matchAll(pattern)) {
            const key = `${type}:${message.seq}:${match[0]}`;
            if (!meta.sizeReportKeys.has(key)) {
              meta.sizeReportKeys.add(key);
              this.record({ connectionId: id, direction: "proxy", type,
                cols: Number(match[1]), rows: Number(match[2]), seq: message.seq });
            }
          }
        }
        meta.outputTail = text.slice(-MAX_OUTPUT_MARKER_LENGTH);
      }
      this.record({ connectionId: id, direction: "server", type: message.type,
        ...(message.leaseId ? { leaseId: message.leaseId } : {}),
        ...(Number.isSafeInteger(message.seq) ? { seq: message.seq } : {}),
        ...(Number.isSafeInteger(message.latestSeq) ? { latestSeq: message.latestSeq } : {}),
        ...(typeof message.replayGap === "boolean" ? { replayGap: message.replayGap } : {}),
        ...(typeof message.code === "string" ? { code: message.code } : {}) });
      if (this.dropNextOutput && message.type === "terminal.output" && meta.attached) {
        this.dropNextOutput = false;
        this.droppedOutputSeq = message.seq;
        this.record({ connectionId: id, direction: "proxy", type: "output.dropped", seq: message.seq });
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(String(data));
    });
    const disconnected = () => this.record({ connectionId: id, direction: "proxy", type: "disconnect" });
    socket.once("close", disconnected);
    upstream.once("close", () => { if (socket.readyState === WebSocket.OPEN) socket.close(); });
    socket.once("close", () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });
    socket.on("error", () => {});
    upstream.on("error", () => { if (socket.readyState === WebSocket.OPEN) socket.close(1011); });
  }

  /** @returns 当前已启动的终端连接 */
  terminalConnection() {
    return [...this.connections.values()].find((item) => item.terminal
      && (item.socket.readyState === WebSocket.OPEN || item.upstream.readyState === WebSocket.OPEN)) ?? null;
  }

  /** @returns 无返回值；只断开当前终端连接，不关闭页面 */
  disconnectTerminal() {
    const current = this.terminalConnection();
    assert(current, "没有可断开的终端连接");
    this.record({ connectionId: current.id, direction: "proxy", type: "forced.disconnect" });
    current.socket.terminate();
    current.upstream.terminate();
  }

  /** @returns 无返回值；只断开普通聊天连接，终端 owner 连接保持打开 */
  disconnectChats() {
    let count = 0;
    for (const item of this.connections.values()) {
      if (item.terminal || (item.socket.readyState !== WebSocket.OPEN && item.upstream.readyState !== WebSocket.OPEN)) continue;
      count += 1;
      this.record({ connectionId: item.id, direction: "proxy", type: "forced.chat-disconnect" });
      item.socket.terminate();
      item.upstream.terminate();
    }
    assert(count >= 2, "没有同时断开两个普通聊天视图");
  }

  /** @returns 无返回值；关闭代理自己的全部连接 */
  async close() {
    for (const item of this.connections.values()) {
      try { item.socket.terminate(); } catch {}
      try { item.upstream.terminate(); } catch {}
    }
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

/**
 * 真实 CLI 的隔离环境；所有 API 地址均固定到本轮回环假上游。
 * @returns {NodeJS.ProcessEnv} 不含用户模型、服务提供方或自定义请求头覆盖的环境
 */
function realCliEnvironment() {
  assert(realUpstream && realCliPath, "真实 CLI 假上游尚未初始化");
  const env = {
    ...process.env,
    HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_CODE_PATH: realCliPath,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${realInterruptUpstream?.port ?? realUpstream.port}`,
    ANTHROPIC_API_KEY: "mock-local-only", ANTHROPIC_AUTH_TOKEN: "mock-local-only",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  // 验收由 Claude Code 启动时必须移除子会话标记，否则真实交互 CLI 会刻意关闭转录持久化。
  delete env.CLAUDE_CODE_CHILD_SESSION;
  for (const key of [
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ]) delete env[key];
  return env;
}

/**
 * 只延迟固定中断标记的本机回环代理；其他请求原样转发到隔离假上游。
 * @returns {Promise<{server: http.Server, port: number, delayed: number, aborted: number,
 *   timers: Set<NodeJS.Timeout>, sockets: Set<import("node:net").Socket>}>} 可控中断证据
 */
async function startRealCliInterruptProxy() {
  assert(realUpstream, "真实 CLI 上游尚未初始化");
  const state = { server: null, port: 0, delayed: 0, aborted: 0, timers: new Set(), sockets: new Set() };
  state.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => { chunks.push(chunk); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const isInterrupt = body.toString("utf8").includes(REAL_MARKERS.interruptUser);
      const forward = () => {
        if (res.destroyed) return;
        const upstreamRequest = http.request({
          host: "127.0.0.1", port: realUpstream.port, path: req.url, method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${realUpstream.port}` },
        }, (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        });
        upstreamRequest.on("error", () => { if (!res.destroyed) res.destroy(); });
        upstreamRequest.end(body);
      };
      if (!isInterrupt) { forward(); return; }
      state.delayed += 1;
      const timer = setTimeout(() => { state.timers.delete(timer); forward(); }, 15000);
      state.timers.add(timer);
      res.once("close", () => {
        if (res.writableEnded) return;
        clearTimeout(timer);
        state.timers.delete(timer);
        state.aborted += 1;
      });
    });
  });
  state.server.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.once("close", () => state.sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    state.server.once("error", reject);
    state.server.listen(0, "127.0.0.1", resolve);
  });
  const address = state.server.address();
  assert(address && typeof address !== "string", "中断代理监听失败");
  state.port = address.port;
  return state;
}

/** @returns 无返回值；定向关闭本轮代理、挂起计时器与连接 */
async function closeRealCliInterruptProxy() {
  if (!realInterruptUpstream) return;
  for (const timer of realInterruptUpstream.timers) clearTimeout(timer);
  realInterruptUpstream.timers.clear();
  for (const socket of realInterruptUpstream.sockets) socket.destroy();
  await new Promise((resolve) => realInterruptUpstream.server.close(resolve));
  realInterruptUpstream = null;
}

/**
 * 启动本轮隔离桥接；portable 正常路径只运行外层单 exe，显式 terminalExe 仍用于原生故障注入。
 * @param extraEnv 仅本场景覆盖的环境
 * @param terminalExe 可选的独立完整目录 Console 入口
 * @returns 隔离桥接运行时信息
 */
async function startBridge(extraEnv = {}, terminalExe = null) {
  const usePortable = portable && terminalExe === null;
  const previousPid = lastPortableBridgePid;
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({
    token, port: runtimePort, allowedOrigins: [`chrome-extension://${EXTENSION_ID}`], createdAt: new Date().toISOString(),
  }), "utf8");
  const env = realCliResumeOnly ? {
    ...realCliEnvironment(), CCC_BRIDGE_HOME: home, ...extraEnv,
  } : {
    ...process.env,
    HOME: root, USERPROFILE: root, CCC_BRIDGE_HOME: home, CLAUDE_CONFIG_DIR: claudeConfig,
    CLAUDE_CODE_PATH: isolatedFakeCli, ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}`,
    ANTHROPIC_API_KEY: "mock-local-only", ANTHROPIC_AUTH_TOKEN: "mock-local-only",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
    CCC_FAKE_CLI_DELAY_STREAM_INIT_MS: "10000",
    ...extraEnv,
  };
  delete env.CCC_FAKE_CLI_DISABLE_HOOKS;
  if (extraEnv.CCC_FAKE_CLI_DISABLE_HOOKS) env.CCC_FAKE_CLI_DISABLE_HOOKS = extraEnv.CCC_FAKE_CLI_DISABLE_HOOKS;
  // 外层必须自行注入已校验目录；验收父进程不得替它绕过生产入口检查。
  delete env.CCC_PORTABLE_RUNTIME_DIR;
  bridgeEnvironment = env;
  bridgePid = null;
  bridgeTray = null;
  bridgeLaunchPortable = usePortable;
  bridgeExecutable = usePortable ? null : terminalExe ?? isolatedTerminalExe;
  const stderrFd = fs.openSync(path.join(root, `bridge-${Date.now()}.stderr.log`), "a");
  if (usePortable) {
    // 与用户双击一致；外层启动内层后自行退出，外层 PID 绝不能冒充内层。
    bridgeChild = spawn(isolatedExe, [], {
      cwd, env, detached: false, windowsHide: false, stdio: ["ignore", "ignore", stderrFd],
    });
  } else {
    // 原 Console 启动器只负责建立独占 Console 并回报真实 PID。
    bridgeChild = spawn(windowProbe, ["console-start-wait", terminalExe ?? isolatedTerminalExe, cwd, "start"], {
      cwd: toolsDir, env, detached: false, windowsHide: true, stdio: ["ignore", "pipe", stderrFd],
    });
  }
  fs.closeSync(stderrFd);
  bridgeChildren.add(bridgeChild);
  const launcher = bridgeChild;
  let launcherOutput = "";
  if (!usePortable) {
    launcher.stdout.setEncoding("utf8");
    launcher.stdout.on("data", (chunk) => {
      launcherOutput = `${launcherOutput}${chunk}`.slice(-4096);
      if (bridgePid !== null || !launcherOutput.includes("\n")) return;
      const firstLine = launcherOutput.split(/\r?\n/, 1)[0];
      const parsed = JSON.parse(firstLine);
      if (Number.isInteger(parsed.pid)) bridgePid = parsed.pid;
    });
  }
  const launchedPid = usePortable ? await waitFor(() => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(home, "runtime.json"), "utf8"));
      return value.pid > 0 && value.pid !== previousPid && value.port > 0 ? value.pid : null;
    } catch { return null; }
  }, "绿色单文件内层桥接 PID", 30000) : await waitFor(() => bridgePid, "隔离 Console 启动器回报真实桥接 PID", 10000);
  assert(launchedPid !== launcher.pid && launchedPid !== process.pid, "桥接 PID 与启动器或验收父进程重复");
  const runtime = await waitFor(() => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(home, "runtime.json"), "utf8"));
      return value.pid === launchedPid && value.port > 0 ? value : null;
    } catch { return null; }
  }, "隔离桥接启动", 15000);
  const identity = await waitFor(() => processIdentity(launchedPid), "隔离桥接进程身份");
  if (usePortable) {
    const executable = identity.executable;
    const runtimeDir = path.dirname(executable);
    const runtimeRoot = path.join(home, "runtime");
    assert(path.basename(executable).toLowerCase() === "ccc-bridge.exe"
      && path.resolve(path.dirname(runtimeDir)).toLowerCase() === path.resolve(runtimeRoot).toLowerCase()
      && /^[a-f0-9]{64}$/.test(path.basename(runtimeDir)), "绿色内层不在 home/runtime/<payloadHash>/ccc-bridge.exe");
    const runtimeManifest = path.join(runtimeDir, "pty-manifest.json");
    manifestHash = createHash("sha256").update(fs.readFileSync(runtimeManifest)).digest("hex");
    assert(manifestHash === sourceManifestHash, "绿色内层 PTY manifest 与当前构建不一致");
    bridgeExecutable = executable;
    lastPortableBridgePid = launchedPid;
    evidence.portableRuntimeIdentity = true;
    evidence.observations.manifestHash = manifestHash;
    evidence.observations.portableLaunch = {
      outerPid: launcher.pid, innerPid: launchedPid, payloadHash: path.basename(runtimeDir), innerExecutable: executable,
    };
  } else {
    const expected = terminalExe ?? isolatedTerminalExe;
    assert(identity.executable.toLowerCase() === expected.replace(/\\/g, "/").toLowerCase(),
      "真实桥接可执行路径与本轮隔离发行副本不一致");
  }
  ownedProcesses.set(launchedPid, { role: "bridge", ...identity });
  if (usePortable) {
    await waitFor(() => launcher.exitCode !== null ? true : null, "绿色外层启动完成后退出", 10000);
    assert(launcher.exitCode === 0, "绿色外层启动退出码异常：" + launcher.exitCode);
    evidence.observations.portableLaunch.outerExitCode = launcher.exitCode;
    const trayPath = path.join(home, "traybin", "tray_windows_release.exe");
    bridgeTray = await waitFor(() => {
      try {
        return JSON.parse(execFileSync(windowProbe, ["tray-find", String(launchedPid), trayPath], {
          encoding: "utf8", windowsHide: true, timeout: 4000,
        }));
      } catch { return null; }
    }, "绿色内层独占托盘 helper 身份", 10000);
    // 登记与最终复核统一使用 WMI 身份；.NET startTicks 只用于托盘消息发送前的精确复核。
    // 两个提供者的 FILETIME 舍入可能不同，不能跨来源比较转换后的 ISO 时间。
    const trayIdentity = await waitFor(() => processIdentity(bridgeTray.pid), "托盘 helper WMI 进程身份");
    assert(trayIdentity.executable.toLowerCase() === bridgeTray.executable.toLowerCase(),
      "托盘 helper 的 WMI 与原生路径不一致");
    ownedProcesses.set(bridgeTray.pid, { role: "tray", ...trayIdentity });
  }
  runtimePort = runtime.port;
  if (control) control.close();
  control = await ControlClient.connect();
  // 本验收不扩展为“桥接进程崩溃后的草稿持久化”；重启后重新注入固定草稿，
  // 继续验证 lease 接管、恢复和 reconnect 本身不会清空它。
  control.send({ type: "chat.draft", text: "DRAFT_BEFORE_TERMINAL" });
  return runtime;
}

/** @param graceful 是否通过真实 Console 关闭或托盘“退出”菜单并等待异步清理 @returns 隔离桥接退出后的 Promise */
async function stopBridge(graceful = false) {
  if (control) { control.close(); control = null; }
  if (!bridgeChild && bridgePid === null) return;
  const launcher = bridgeChild;
  const usePortable = bridgeLaunchPortable;
  const tray = bridgeTray;
  let targetPid = bridgePid;
  if (targetPid === null) {
    // 启动器回报解析失败时，只接受隔离 runtime 指向的唯一发行副本，不按标题或 PID 猜杀。
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(home, "runtime.json"), "utf8")).pid;
      const identity = processIdentity(candidate);
      if (identity && bridgeExecutable
        && identity.executable.toLowerCase() === bridgeExecutable.replace(/\\/g, "/").toLowerCase()) {
        targetPid = candidate;
        bridgePid = candidate;
        ownedProcesses.set(candidate, { role: "bridge", ...identity });
      }
    } catch { /* 启动器清理仍继续 */ }
  }
  if (targetPid === null) {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    bridgeChild = null;
    bridgeTray = null;
    bridgeLaunchPortable = false;
    return;
  }
  if (pidAlive(targetPid)) {
    if (graceful && usePortable) {
      assert(tray && tray.parentPid === targetPid, "绿色正常关闭缺少本轮托盘 helper 身份");
      const trayPath = path.join(home, "traybin", "tray_windows_release.exe");
      const result = JSON.parse(execFileSync(windowProbe, [
        "tray-exit", String(targetPid), String(tray.pid), trayPath, tray.startTicks,
      ], { encoding: "utf8", windowsHide: true, timeout: 5000 }));
      assert(result.sent === true && result.command === 5 && result.tray?.pid === tray.pid
        && result.tray?.parentPid === targetPid, "未确认定向托盘“退出”菜单命令");
      evidence.observations.gracefulClose = {
        method: "tray-menu-exit", bridgePid: targetPid, trayPid: tray.pid, command: result.command,
      };
    } else if (graceful) {
      const result = JSON.parse(execFileSync(windowProbe, ["console-close", String(targetPid), String(process.pid)], {
        encoding: "utf8", windowsHide: true, timeout: 5000,
      }));
      assert(result.sent === true && result.isolatedConsole === true && result.consolePid === targetPid,
        "未确认定向隔离 Console 正常关闭");
      evidence.observations.gracefulClose = { method: "WM_CLOSE", bridgePid: targetPid };
    } else {
      const owned = ownedProcesses.get(targetPid);
      const actual = processIdentity(targetPid);
      assert(owned?.role === "bridge" && actual
        && actual.executable.toLowerCase() === owned.executable.toLowerCase()
        && Date.parse(actual.startedAt) === Date.parse(owned.startedAt), "异常清理前桥接身份核对失败");
      process.kill(targetPid); // 只强杀本轮登记且刚刚复核身份的隔离桥接。
    }
    await waitFor(() => !pidAlive(targetPid) ? true : null,
      graceful ? "真实正常关闭后桥接退出" : "异常夹具桥接退出", graceful ? 15000 : 3000);
  }
  let trayCleanup = null;
  if (tray) {
    let killSent = false;
    let identityAvailable = false;
    if (!graceful && pidAlive(tray.pid)) {
      // 父桥接退出会关闭 helper 的 stdin，helper 可能正在自行退出。
      // WMI 已查不到身份时不把退出竞态误判为身份不符；只有身份仍完整可核对才定向结束。
      const owned = ownedProcesses.get(tray.pid);
      const actual = processIdentity(tray.pid);
      assert(owned?.role === "tray", "托盘 helper 清理前缺少登记身份");
      if (actual) {
        identityAvailable = true;
        assert(actual.executable.toLowerCase() === owned.executable.toLowerCase()
          && Date.parse(actual.startedAt) === Date.parse(owned.startedAt),
        `托盘 helper 清理前身份核对失败：expected=${owned.startedAt}, actual=${actual.startedAt}`);
        process.kill(tray.pid);
        killSent = true;
      }
    }
    await waitFor(() => !pidAlive(tray.pid) ? true : null,
      graceful ? "托盘“退出”后 helper 正常退出" : "异常夹具托盘 helper 退出", graceful ? 12000 : 3000);
    trayCleanup = { pid: tray.pid, killSent, identityAvailable, exited: true };
    if (usePortable) evidence.observations.lastPortableTrayCleanup = trayCleanup;
  }
  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    const exited = new Promise((resolve) => launcher.once("exit", resolve));
    await Promise.race([exited, delay(3000)]);
  }
  assert(!pidAlive(targetPid), "桥接目标 PID 仍存在");
  assert(!launcher || launcher.exitCode !== null || launcher.signalCode !== null, "桥接启动器未退出");
  if (graceful) {
    assert(!launcher || launcher.exitCode === 0, "桥接启动器正常路径退出码异常：" + launcher?.exitCode);
    assert(!fs.existsSync(path.join(home, "runtime.json")), "桥接正常关闭后 runtime.json 仍存在");
    if (usePortable) evidence.portableGracefulShutdown = true;
  }
  bridgeChild = null;
  bridgePid = null;
  bridgeTray = null;
  bridgeLaunchPortable = false;
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
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
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
  setupPage = setup;
  await setup.send("Page.navigate", { url: PAGE_URL });
  await waitFor(() => evaluate(setup, "document.readyState === 'complete' && Boolean(chrome.storage)"), "扩展设置页");
  const settings = { token, port: proxy.port, host: "127.0.0.1", folderHistory: [], attachEnabled: false,
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
  const result = JSON.parse(execFileSync(windowProbe, ["close", handle], {
    encoding: "utf8", windowsHide: true, timeout: 5000,
  }));
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
  const identity = processIdentity(status.pid);
  assert(identity && identity.executable.toLowerCase() === String(status.executable).toLowerCase()
    && Date.parse(identity.startedAt) === Date.parse(status.startedAt), "隔离终端包装身份复核失败");
  ownedProcesses.set(status.pid, { role: "system-terminal", leaseId, ...identity });
  terminalWindows.add(handle);
  terminalConsolePids.set(handle, status.pid);
}

/**
 * 采样系统窗口关闭后的真实包装进程、退出文件和公开 lease，避免旧 idle 或窗口消失冒充退出。
 * @param {string} leaseId 当前系统 lease
 * @param {number} pid 已登记包装 PID
 * @returns {Promise<Array<Record<string, unknown>>>} 不含环境或 token 的时序证据
 */
async function observeSystemWindowClose(leaseId, pid) {
  const samples = [];
  const startedAt = Date.now();
  const deadline = startedAt + 10000;
  while (Date.now() <= deadline) {
    const sample = {
      elapsedMs: Date.now() - startedAt,
      processAlive: pidAlive(pid),
      exitFile: fs.existsSync(path.join(home, "terminal", `${leaseId}.exit.json`)),
      phase: control?.terminalState()?.phase ?? null,
    };
    samples.push(sample);
    if (!sample.processAlive || sample.exitFile || sample.phase === "idle") break;
    await delay(250);
  }
  evidence.observations.realCliSystemWindowClose = { leaseId, pid, samples };
  return samples;
}

/** @param backend 期望后端 @returns 从真实按钮启动后的公开状态和窗口句柄 */
async function openFromSidepanel(backend) {
  const baseline = new Set(listWindows().map((item) => item.handle));
  const messageStart = control.inbox.length;
  const clicked = await evaluate(sidepanel, `(() => {
    const button = document.querySelector('button[aria-label="在系统终端打开并继续当前会话"]');
    if (!button || button.disabled) return false; button.click(); return true;
  })()`);
  assert(clicked, "系统终端真实按钮不可点击");
  const state = await control.wait((message) => control.inbox.indexOf(message) >= messageStart
    && message.type === "terminal.state"
    && (message.state.phase === "active" || message.state.phase === "degraded" || message.state.phase === "idle"),
  `${backend} 启动状态`, 20000);
  if (state.state.phase === "idle") {
    const message = await evaluate(sidepanel, "document.querySelector('.terminal-error')?.textContent || ''");
    throw new Error(`${backend} 启动后回到 idle：${message || "无页面错误文本"}`);
  }
  assert(state.state.backend === backend, `实际后端不是 ${backend}`);
  const handle = (await findTerminalWindow(baseline, backend)).handle;
  trackTerminalConsole(handle, state.state.leaseId);
  return { state: state.state, handle };
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
  const required = [
    "terminalWindowVisible", "terminalWindowDeduped", "authenticatedBeforeOpen",
    "attachedAfterOpenedOnSameConnection", "resumedCorrectSession", "inputAndContinuousOutput",
    "chineseInputOutput", "imeCompositionNotDuplicated", "resizedPtyTo132x36",
    "terminalToolbarVisible", "realClipboardMultilineCopy", "ctrlCCopiesSelection",
    "ctrlShiftCCopiesSelection", "buttonPasteMultilineChinese", "ctrlShiftVPasteMultilineChinese",
    "sidepanelAndChatPopupReadonly", "jsonlMirrorNotAnsiParsed", "clearResumeForkFollowedHooks",
    "noSessionUsesGeneratedUuid", "compactAndTaskCollapsedExpandable", "ordinaryExternalSessionListedWithoutTakeover",
    "directWritesRejected", "nonOwnerControlsRejected", "replayContiguous",
    "reconnectWithin3Seconds", "reconnectAfter3SecondsKillsOwnedPty", "refreshCannotReuseAttachToken",
    "outputGapVisibleAndCloses", "closeButtonRestoresLastHookSession", "chatDisconnectDoesNotKillPty",
    "pagehideClosesOwnedPty", "bridgeShutdownKillsOwnedPty", "abnormalRestartClearsExitedConpty",
    "matchedIdentityRecoveryKillsOnlyOwnedPty",
    "abnormalRestartNeverKillsUnknownIdentity",
    "nativeFailureLeavesChatAndSystemTerminalUsable", "systemAndEmbeddedMutuallyExclusive",
    "commandHooksWithoutFailure", "compiledExeOutsideProjectTree",
  ];
  if (portable) {
    evidence.portableSingleFileOnly = fs.readdirSync(appDir).length === 1
      && fs.readdirSync(appDir)[0] === "CopilotCC.exe";
    required.push("portableSingleFileOnly", "portableRuntimeIdentity", "portableGracefulShutdown");
  }
  for (const name of required) {
    if (evidence[name] !== true) throw new Error(`验收失败: ${name}，实际=${JSON.stringify(evidence[name])}`);
  }
  if (evidence.realApiCalled !== false || evidence.macOSVerified !== false) {
    throw new Error("验收平台或真实 API 边界被篡改");
  }
  if (evidence.runtimeErrors.length !== 0) throw new Error("Chrome 存在运行错误");
}

/** @param pid 待核对 PID @returns 真实可执行路径与启动时间；不存在或查询失败返回 null */
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

/** @param pid 进程 PID @returns 当前是否存活 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/** @param excludedLeaseId 刷新时必须排除的旧 lease @returns 当前 embedded 私有记录中的非敏感身份，且登记为仅本轮可清理进程 */
async function trackEmbeddedProcess(excludedLeaseId = null) {
  return waitFor(() => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(home, "terminal", "embedded-lease.json"), "utf8"));
      if (record.mode !== "embedded" || !record.identity || record.identity.pid !== record.pid
        || record.leaseId === excludedLeaseId) return null;
      const identity = record.identity;
      ownedProcesses.set(record.pid, {
        role: "embedded", executable: identity.executable, startedAt: identity.startedAt, leaseId: record.leaseId,
      });
      return { leaseId: record.leaseId, pid: record.pid, identity };
    } catch { return null; }
  }, "embedded PID+路径+启动时间身份");
}

/** @param pid 登记的 PTY PID @returns 进程已退出时为 true */
async function waitPidExit(pid) {
  await waitFor(() => !pidAlive(pid) ? true : null, ` owned PTY ${pid} 退出`, 12000);
  return true;
}

/**
 * 启动独立于 ConPTY 的真实存活故障注入进程，登记完整身份供恢复验收定向核对。
 * @param role 固定的 matched/unknown 场景名
 * @returns 本轮独占子进程及 PID、可执行路径、启动时间
 */
async function startRecoverySurvivor(role) {
  assert(role === "matched" || role === "unknown", "未知恢复故障注入场景");
  const script = path.join(toolsDir, `${role}-survivor.cjs`);
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, [script], { cwd, stdio: "ignore", windowsHide: true });
  externalChildren.add(child);
  assert(Number.isInteger(child.pid) && child.pid > 0, "恢复故障注入进程没有 PID");
  const identity = await waitFor(() => processIdentity(child.pid), `${role} 存活进程身份`);
  ownedProcesses.set(child.pid, { role: `recovery-${role}`, ...identity });
  return { child, pid: child.pid, identity };
}

/**
 * 桥接停止期间把隔离 lease 指向仍存活的真实故障注入进程；私有 token 只原地保留、绝不输出。
 * @param leaseId 刚由真实 embedded 启动产生的 lease
 * @param survivor 独立存活进程及完整身份
 * @param tamperStartedAt 是否篡改启动时间制造 unknown
 * @returns 无返回值
 */
function injectRecoveryIdentity(leaseId, survivor, tamperStartedAt = false) {
  const leaseFile = path.join(home, "terminal", "embedded-lease.json");
  const record = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  assert(record.leaseId === leaseId && record.mode === "embedded" && record.phase === "active",
    "恢复故障注入的 lease 不属于当前真实场景");
  record.pid = survivor.pid;
  record.identity = { ...survivor.identity };
  if (tamperStartedAt) {
    record.identity.startedAt = new Date(Date.parse(record.identity.startedAt) + 60_000).toISOString();
  }
  fs.writeFileSync(leaseFile, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
}

/** @param target 终端 CDP target @returns 已附加并登记的终端页面 */
async function registerTerminalTarget(target) {
  if (!terminalPage || terminalTargetId !== target.id) {
    terminalPage = await attachPage(target, "terminal");
    terminalTargetId = target.id;
  }
  const info = await browserCdp.send("Browser.getWindowForTarget", { targetId: target.id });
  ownedChromeWindowIds.add(info.windowId);
  return terminalPage;
}

/**
 * 等待代理在真实 PTY 输出中命中固定非敏感标记。
 * @param marker 预登记标记名 @param label 验收步骤 @param timeoutMs 超时毫秒
 * @returns 命中后为 true
 */
async function waitOutputMarker(marker, label, timeoutMs = 30000) {
  return waitFor(() => proxy.events.some((event) => event.type === "output.marker"
    && event.marker === marker) ? true : null, label, timeoutMs);
}

/** @param line 要写入真实 xterm 的一行 @returns 无返回值 */
async function sendTerminalLine(line) {
  assert(terminalPage, "终端页面尚未登记");
  await terminalPage.send("Page.bringToFront");
  await evaluate(terminalPage, "document.querySelector('.xterm-helper-textarea')?.focus(); true");
  await terminalPage.send("Input.insertText", { text: line });
  await terminalPage.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await terminalPage.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
}

/** @param key 单键名称 @param ctrl 是否按 Ctrl @param shift 是否按 Shift @returns 无返回值 */
async function dispatchTerminalKey(key, ctrl = false, shift = false) {
  assert(terminalPage, "终端页面尚未登记");
  const upper = key.toUpperCase();
  const code = upper.length === 1 && /[A-Z]/.test(upper) ? `Key${upper}` : key;
  const virtualKey = upper.length === 1 ? upper.charCodeAt(0) : key === "Escape" ? 27 : 0;
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  await terminalPage.send("Page.bringToFront");
  await evaluate(terminalPage, "document.querySelector('.xterm-helper-textarea')?.focus(); true");
  await terminalPage.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: shift ? upper : key.toLowerCase(), code, modifiers,
    windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
  });
  await terminalPage.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: shift ? upper : key.toLowerCase(), code, modifiers,
    windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
  });
}

/** @param point 页面坐标 @param pressed 是否按下 @returns 无返回值 */
async function mouseTerminal(point, pressed = null) {
  if (pressed === null) {
    await terminalPage.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    return;
  }
  await terminalPage.send("Input.dispatchMouseEvent", {
    type: pressed ? "mousePressed" : "mouseReleased", ...point,
    button: "left", buttons: pressed ? 1 : 0, clickCount: 1,
  });
}

/** @param label 工具栏按钮精确文本 @returns 无返回值；通过真实 CDP 鼠标点击 */
async function clickTerminalToolbarButton(label) {
  const point = await evaluate(terminalPage, `(() => {
    const button = [...document.querySelectorAll('.terminal-toolbar button')]
      .find(el => (el.textContent || '').trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(point, `终端工具栏按钮不可点击：${label}`);
  await mouseTerminal(point, true);
  await mouseTerminal(point, false);
}

/** @returns 工具栏、快捷键与历史说明在真实窗口中可见 */
async function verifyTerminalToolbar() {
  const state = await evaluate(terminalPage, `(() => {
    const toolbar = document.querySelector('.terminal-toolbar');
    const rect = toolbar?.getBoundingClientRect();
    return {
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      buttons: [...document.querySelectorAll('.terminal-toolbar button')].map(el => el.textContent || ''),
      shortcuts: document.querySelector('.terminal-shortcuts')?.textContent || '',
      footer: document.querySelector('.terminal-footer')?.textContent || '',
    };
  })()`);
  evidence.terminalToolbarVisible = state.visible && ["复制", "粘贴", "可滚历史"].every((name) => state.buttons.includes(name))
    && state.shortcuts.includes("无选区 Ctrl+C 中断") && state.footer.includes("滚轮");
  assert(evidence.terminalToolbarVisible, "真实终端工具栏或快捷键说明不完整");
  return state;
}

/** @returns 无返回值；用真实鼠标拖选两行固定假 CLI 输出 */
async function selectFixedTerminalOutput() {
  const points = await evaluate(terminalPage, `(() => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    const first = rows.find(el => (el.textContent || '').includes('FAKE_ECHO: hello embedded'));
    const last = rows.find(el => (el.textContent || '').includes('FAKE_ECHO: 中文输入'));
    if (!first || !last) return null;
    const a = first.getBoundingClientRect(); const b = last.getBoundingClientRect();
    return { start: { x: a.left + 2, y: a.top + a.height / 2 },
      end: { x: b.right - 3, y: b.top + b.height / 2 } };
  })()`);
  assert(points, "固定终端输出不在可见 xterm 行中");
  await mouseTerminal(points.start, true);
  await mouseTerminal(points.end);
  await mouseTerminal(points.end, false);
  await waitFor(() => evaluate(terminalPage, `(() => {
    const button = [...document.querySelectorAll('.terminal-toolbar button')]
      .find(el => (el.textContent || '').trim() === '复制');
    return button && !button.disabled ? true : null;
  })()`), "鼠标选区启用复制按钮", 3000);
}

/** @param text 固定测试文本 @returns 无返回值；覆盖前不读取原剪贴板 */
async function seedTestClipboard(text) {
  const written = await evaluate(terminalPage, `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`);
  assert(written === true, "隔离 Chrome 无法写入固定测试剪贴板");
}

/** @returns 只在固定 seed 或本轮复制之后读取的测试剪贴板文本 */
async function readTestClipboard() {
  return evaluate(terminalPage, "navigator.clipboard.readText()");
}

/** @returns 无返回值；真实系统剪贴板、多行中文、按钮和快捷键全链路验收 */
async function verifyTerminalClipboardAndShortcuts() {
  await verifyTerminalToolbar();
  // 首先覆盖系统剪贴板，之后任何 readText 都不会读取用户原内容。
  await seedTestClipboard("CCC_CLIPBOARD_TEST_RESET");
  await selectFixedTerminalOutput();
  await seedTestClipboard("CCC_BUTTON_COPY_RESET");
  await clickTerminalToolbarButton("复制");
  const buttonCopied = await readTestClipboard();
  evidence.realClipboardMultilineCopy = buttonCopied.includes("FAKE_ECHO: hello embedded")
    && buttonCopied.includes("FAKE_ECHO: 中文输入") && buttonCopied.includes("\n");
  assert(evidence.realClipboardMultilineCopy, "复制按钮未复制真实多行鼠标选区");

  await selectFixedTerminalOutput();
  await seedTestClipboard("CCC_CTRL_C_COPY_RESET");
  await dispatchTerminalKey("c", true, false);
  const ctrlCCopied = await readTestClipboard();
  evidence.ctrlCCopiesSelection = ctrlCCopied.includes("FAKE_ECHO: hello embedded")
    && ctrlCCopied.includes("FAKE_ECHO: 中文输入");
  assert(evidence.ctrlCCopiesSelection, "有选区 Ctrl+C 未复制");

  await selectFixedTerminalOutput();
  await seedTestClipboard("CCC_CTRL_SHIFT_C_COPY_RESET");
  await dispatchTerminalKey("c", true, true);
  const ctrlShiftCopied = await readTestClipboard();
  evidence.ctrlShiftCCopiesSelection = ctrlShiftCopied.includes("FAKE_ECHO: hello embedded")
    && ctrlShiftCopied.includes("FAKE_ECHO: 中文输入");
  assert(evidence.ctrlShiftCCopiesSelection, "Ctrl+Shift+C 未复制");
  await screenshot(terminalPage, "embedded-selection-copy.png");

  const buttonPasteSeed = "粘贴第一行\n粘贴第二行";
  await seedTestClipboard(buttonPasteSeed);
  const buttonPasteReadback = await readTestClipboard();
  evidence.observations.buttonPasteSeed = {
    hasFirstLine: buttonPasteReadback.includes("粘贴第一行"),
    hasSecondLine: buttonPasteReadback.includes("粘贴第二行"),
    carriageReturns: (buttonPasteReadback.match(/\r/g) ?? []).length,
    lineFeeds: (buttonPasteReadback.match(/\n/g) ?? []).length,
  };
  assert(buttonPasteReadback.replace(/\r\n/g, "\n") === buttonPasteSeed,
    "固定多行 seed 在系统剪贴板读回时不完整");
  await clickTerminalToolbarButton("粘贴");
  await waitOutputMarker("button-paste-a", "按钮粘贴中文第一行", 8000);
  // 无末尾换行的粘贴把第二行留在 readline 输入区；显式 Enter 才提交，产品不得擅自执行它。
  await sendTerminalLine("");
  await waitOutputMarker("button-paste-b", "按钮粘贴中文第二行", 8000);
  evidence.buttonPasteMultilineChinese = true;

  await seedTestClipboard("快捷粘贴甲\n快捷粘贴乙");
  await dispatchTerminalKey("v", true, true);
  await waitOutputMarker("shortcut-paste-a", "Ctrl+Shift+V 中文第一行", 8000);
  await sendTerminalLine("");
  await waitOutputMarker("shortcut-paste-b", "Ctrl+Shift+V 中文第二行", 8000);
  evidence.ctrlShiftVPasteMultilineChinese = true;
  evidence.observations.clipboard = {
    fixedSeedOverwrittenBeforeRead: true, buttonMultiline: true,
    ctrlCSelection: true, ctrlShiftCSelection: true, ctrlShiftVMultiline: true,
  };
  await screenshot(terminalPage, "embedded-multiline-paste.png");
}

/** @returns 从真实别名菜单打开或聚焦的 embedded 页面、公开状态与私有身份 */
async function openEmbeddedWindow() {
  const before = (await targets()).filter((target) => target.url.startsWith(TERMINAL_PAGE_URL)).map((target) => target.id);
  const messageStart = control.inbox.length;
  const clicked = await evaluate(sidepanel, `(() => {
    const menu = document.querySelector('details.terminal-menu');
    const button = document.querySelector('button[aria-label="在插件终端打开并继续当前会话"]');
    if (!menu || !button || button.disabled) return false;
    menu.open = true; button.click(); return true;
  })()`);
  assert(clicked, "插件终端真实菜单按钮不可点击");
  const target = await waitFor(async () => (await targets()).find((item) => item.url.startsWith(TERMINAL_PAGE_URL)
    && item.webSocketDebuggerUrl) ?? null, "独立 terminal.html target");
  await registerTerminalTarget(target);
  await terminalPage.send("Page.bringToFront");
  await waitFor(() => evaluate(terminalPage, "document.visibilityState === 'visible' ? true : null"),
    "独立终端页面真实可见", 5000);
  const state = await control.wait((message) => control.inbox.indexOf(message) >= messageStart
    && message.type === "terminal.state" && ["starting", "active", "degraded"].includes(message.state.phase)
    && message.state.mode === "embedded", "embedded 启动状态", 20000);
  const owned = await trackEmbeddedProcess();
  await waitFor(async () => (await evaluate(terminalPage, "document.querySelector('.terminal-phase')?.textContent || ''"))
    .includes("终端已连接") ? true : null, "xterm 已 attached", negativeControl ? 5000 : 15000)
    .catch((error) => { if (!negativeControl) throw error; });
  return { state: state.state, target, owned, before };
}

/**
 * 桥接重启后重新绑定同一隔离工作区，不依赖页面自动恢复时序。
 * @param sessionId 要继续的已知会话
 * @returns 绑定完成后的 Promise
 */
async function bindCurrentSession(sessionId) {
  const bindFrom = control.inbox.length;
  control.send({ type: "folder.bind", path: cwd, reset: true });
  await control.wait((message) => control.inbox.indexOf(message) >= bindFrom
    && message.type === "folder.bound" && message.path === cwd, "重启后重新绑定隔离文件夹");
  const switchFrom = control.inbox.length;
  control.send({ type: "session.switch", sessionId });
  await control.wait((message) => control.inbox.indexOf(message) >= switchFrom
    && message.type === "folder.bound" && message.path === cwd && message.sessionId === sessionId,
  "重启后恢复指定会话");
}

/**
 * 打开一个全新的真实内嵌终端，并等待有效 Hook 与双视图只读。
 * @param expectedSessionId 应恢复的会话；null 表示无预置会话，必须生成新 UUID
 * @returns 页面、公开状态与已登记进程身份
 */
async function openFreshEmbedded(expectedSessionId) {
  const opened = await openEmbeddedWindow();
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === opened.owned.leaseId
    && (expectedSessionId ? message.state.currentSessionId === expectedSessionId
      : typeof message.state.currentSessionId === "string"), expectedSessionId ? "新终端恢复指定会话" : "无会话终端生成新会话");
  await verifyReadonly(true);
  return opened;
}

/** @returns 关闭本轮独立终端 target 后的 Promise */
async function closeTerminalTarget() {
  if (!terminalTargetId) return;
  const id = terminalTargetId;
  try { await browserCdp.send("Target.closeTarget", { targetId: id }); } catch {}
  await waitFor(async () => (await targets()).every((target) => target.id !== id) ? true : null, "终端 target 关闭");
  terminalTargetId = null;
  terminalPage = null;
}

/**
 * 真实关闭终端页面，并分别等待 owned PID 退出和桥接回到 idle。
 * @param owned 当前 lease 的私有进程身份
 * @returns 退出确认
 */
async function closeEmbeddedAndWait(owned) {
  const idleFrom = control?.inbox.length ?? 0;
  await closeTerminalTarget();
  const exited = await waitPidExit(owned.pid);
  if (control) {
    await control.wait((message) => control.inbox.indexOf(message) >= idleFrom
      && message.type === "terminal.state" && message.state.phase === "idle", "页面关闭后的新 idle");
  }
  return exited;
}

/** @returns 隔离假 CLI 的非敏感启动与 Hook 事件；文件尚未创建时为空 */
function fakeEvents() {
  const file = path.join(claudeConfig, "fake-cli-events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/** @param sessionId 会话 UUID @returns 该隔离转录的结构化条目 */
function transcriptEntries(sessionId) {
  const file = path.join(claudeConfig, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/** @param leaseId 当前 lease @returns 无返回值；真实调整 Chrome 窗口直到 PTY 为 132×36 */
async function resizePtyTo132x36(leaseId) {
  const resizeEvents = () => proxy.events.filter((event) => event.direction === "client"
    && event.type === "terminal.resize" && event.leaseId === leaseId);
  const initial = await waitFor(() => resizeEvents().at(-1) ?? null, "fit 产生的真实 resize");
  await terminalPage.send("Page.bringToFront");
  await waitFor(() => evaluate(terminalPage, "document.visibilityState === 'visible' ? true : null"),
    "resize 前终端页面可见", 5000);
  if (initial.cols === 132 && initial.rows === 36) {
    evidence.observations.resize = { cols: initial.cols, rows: initial.rows, attempts: 0 };
    return;
  }
  const info = await browserCdp.send("Browser.getWindowForTarget", { targetId: terminalTargetId });
  const metrics = await evaluate(terminalPage, `(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = '14px "Cascadia Mono", Consolas, monospace';
    const row = document.querySelector('.xterm-rows > div');
    return { cellWidth: context.measureText('M').width,
      rowHeight: row ? parseFloat(getComputedStyle(row).height) : 17 };
  })()`);
  const width = Math.max(900, Math.round(info.bounds.width + (132 - initial.cols) * metrics.cellWidth));
  const height = Math.max(620, Math.round(info.bounds.height + (36 - initial.rows) * metrics.rowHeight));
  evidence.observations.resizeAttempts = [{ from: { cols: initial.cols, rows: initial.rows },
    before: { width: info.bounds.width, height: info.bounds.height }, requested: { width, height } }];
  await browserCdp.send("Browser.setWindowBounds", { windowId: info.windowId, bounds: { width, height } });
  // 目标帧可能在起始索引记录前到达；最终 /size 会独立排除已经过时的历史尺寸。
  const target = await waitFor(() => resizeEvents()
    .find((event) => event.cols === 132 && event.rows === 36) ?? null, "真实 PTY 132×36 resize", 15000);
  evidence.observations.resize = { cols: target.cols, rows: target.rows, attempts: 1 };
}

/** 真实 Windows/Chrome 双终端验收主流程。 */
async function run() {
  const projectDir = path.join(claudeConfig, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
  seedTranscript(path.join(projectDir, `${INITIAL_SID}.jsonl`), "TERMINAL_INITIAL_SESSION");
  proxy = await VerificationProxy.listen();
  await startBridge();
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

  const first = await openEmbeddedWindow();
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === first.owned.leaseId && message.state.currentSessionId === INITIAL_SID, "初始 SessionStart Hook");
  const bounds = await browserCdp.send("Browser.getWindowForTarget", { targetId: first.target.id });
  const pageVisibility = await evaluate(terminalPage, "document.visibilityState");
  evidence.observations.initialWindow = { state: bounds.bounds.windowState, visibility: pageVisibility,
    width: bounds.bounds.width, height: bounds.bounds.height };
  evidence.terminalWindowVisible = bounds.bounds.width > 0 && bounds.bounds.height > 0
    && bounds.bounds.windowState === "normal" && pageVisibility === "visible"
    && await evaluate(terminalPage, "Boolean(document.querySelector('.xterm'))");
  await screenshot(terminalPage, "embedded-window-initial.png");
  const targetCount = (await targets()).filter((target) => target.url.startsWith(TERMINAL_PAGE_URL)).length;
  const focused = await evaluate(sidepanel, `(() => {
    const menu = document.querySelector('details.terminal-menu');
    const button = document.querySelector('button[aria-label="在插件终端打开并继续当前会话"]');
    if (!menu || !button || button.disabled) return false; menu.open = true; button.click(); return true;
  })()`);
  assert(focused, "聚焦插件终端按钮不可点击");
  await delay(500);
  evidence.terminalWindowDeduped = targetCount === 1
    && (await targets()).filter((target) => target.url.startsWith(TERMINAL_PAGE_URL)).length === 1;

  const events = proxy.events;
  const openIndex = events.findIndex((event) => event.connectionId && event.direction === "client" && event.type === "terminal.open");
  const openEvent = events[openIndex];
  evidence.authenticatedBeforeOpen = openIndex > 0 && events.slice(0, openIndex).some((event) => event.connectionId === openEvent.connectionId
    && event.direction === "server" && event.type === "auth.ok");
  const openedIndex = events.findIndex((event, index) => index > openIndex && event.connectionId === openEvent.connectionId
    && event.direction === "server" && event.type === "terminal.opened" && event.leaseId === first.owned.leaseId);
  const attachIndex = events.findIndex((event, index) => index > openedIndex && event.connectionId === openEvent.connectionId
    && event.direction === "client" && event.type === "terminal.attach" && event.leaseId === first.owned.leaseId);
  evidence.attachedAfterOpenedOnSameConnection = openedIndex > openIndex && attachIndex > openedIndex
    && events.some((event, index) => index > attachIndex && event.connectionId === openEvent.connectionId
      && event.direction === "server" && event.type === "terminal.attached" && event.leaseId === first.owned.leaseId);
  const starts = fs.readFileSync(path.join(claudeConfig, "fake-cli-events.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((event) => event.kind === "start" && event.resumeArg === INITIAL_SID && event.pid === first.owned.pid);
  evidence.resumedCorrectSession = first.state.initialSessionId === INITIAL_SID && starts.length === 1;
  await verifyReadonly(true);
  evidence.sidepanelAndChatPopupReadonly = evidence.sidepanelReadonly === true && evidence.popupReadonly === true;
  evidence.observations.first = {
    leaseId: first.owned.leaseId, pid: first.owned.pid, targetCount,
    proxy: events.map((event) => ({ ...event })),
  };

  if (negativeControl === "attach") {
    assert(proxy.droppedAttach === 1, "负控没有精确丢弃首次 attach");
    evidence.observations.negativeControl = "已创建真实窗口并收到 terminal.opened；首次 terminal.attach 被代理丢弃";
    assertRequiredEvidence();
    return;
  }

  await sendTerminalLine("hello embedded");
  await waitOutputMarker("ascii-echo", "ASCII 输入及 PTY 输出");
  await screenshot(terminalPage, "embedded-ascii.png");

  await sendTerminalLine("中文输入");
  await waitOutputMarker("chinese-echo", "中文输入及 PTY 输出");
  evidence.chineseInputOutput = transcriptEntries(INITIAL_SID).some((entry) => entry.type === "user"
    && entry.message?.content === "中文输入");

  await evaluate(terminalPage, "document.querySelector('.xterm-helper-textarea')?.focus(); true");
  await terminalPage.send("Input.imeSetComposition", {
    text: "组合输入", selectionStart: 4, selectionEnd: 4, replacementStart: 0, replacementEnd: 0,
  });
  await terminalPage.send("Input.insertText", { text: "组合输入" });
  await terminalPage.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await terminalPage.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await waitOutputMarker("ime-echo", "IME 提交输入");
  evidence.imeCompositionNotDuplicated = transcriptEntries(INITIAL_SID)
    .filter((entry) => entry.type === "user" && entry.message?.content === "组合输入").length === 1;
  await screenshot(terminalPage, "embedded-chinese-ime.png");
  await verifyTerminalClipboardAndShortcuts();

  await sendTerminalLine("/ticks on");
  await waitOutputMarker("tick-3", "正常会话连续 tick", 8000);
  evidence.inputAndContinuousOutput = true;
  await sendTerminalLine("/ticks off");
  await delay(400);
  await resizePtyTo132x36(first.owned.leaseId);
  const resizeEvent = await waitFor(() => proxy.events.find((event) => event.type === "pty.resize"
    && event.cols === 132 && event.rows === 36) ?? null, "PTY 子进程真实 resize 事件", 8000);
  evidence.observations.resizeEvent = resizeEvent;
  await sendTerminalLine("/size");
  const sizeReport = await waitFor(() => proxy.events.find((event) => event.type === "pty.size") ?? null,
    "PTY 子进程尺寸报告", 8000);
  evidence.observations.sizeReport = sizeReport;
  assert(sizeReport.cols === 132 && sizeReport.rows === 36,
    `PTY 子进程尺寸不符：${sizeReport.cols}x${sizeReport.rows}`);
  evidence.resizedPtyTo132x36 = true;
  await screenshot(terminalPage, "embedded-ticks-size.png");
  await waitFor(async () => (await evaluate(sidepanel, "document.querySelector('.message-list')?.textContent || ''"))
    .includes("FAKE_ECHO: 中文输入") ? true : null, "JSONL 中文镜像");
  const mirrorText = await evaluate(sidepanel, "document.querySelector('.message-list')?.textContent || ''");
  const transcriptTexts = transcriptEntries(INITIAL_SID).flatMap((entry) => {
    const content = entry.message?.content;
    if (typeof content === "string") return [content];
    return Array.isArray(content) ? content.map((item) => typeof item.text === "string" ? item.text : "") : [];
  });
  const terminalOnlyTexts = new Set(["/ticks on", "/ticks off", "/size",
    "FAKE_ECHO: /ticks on", "FAKE_ECHO: /ticks off", "FAKE_ECHO: /size"]);
  const terminalCommandLeaks = transcriptTexts.filter((text) => terminalOnlyTexts.has(text)
    || /^TICK:\d+$/.test(text) || /^(?:RE)?SIZE:\d+x\d+$/.test(text));
  evidence.observations.terminalCommandLeaks = terminalCommandLeaks;
  evidence.jsonlMirrorNotAnsiParsed = !mirrorText.includes("ccc-fake") && !mirrorText.includes("TICK:")
    && !mirrorText.includes("SIZE:132x36") && !mirrorText.includes("RESIZE:") && terminalCommandLeaks.length === 0;

  await sendTerminalLine("/clear");
  const cleared = await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === first.owned.leaseId && message.state.currentSessionId
    && message.state.currentSessionId !== INITIAL_SID, "/clear 新会话 Hook");
  const clearSid = cleared.state.currentSessionId;
  await waitFor(() => fakeEvents().some((event) => event.kind === "hook" && event.eventName === "SessionStart"
    && event.source === "clear" && event.sessionId === clearSid) ? true : null, "clear 有效 Hook 来源");
  await waitFor(async () => (await evaluate(sidepanel, "document.querySelector('.message-list')?.textContent || ''"))
    .includes("TERMINAL_CLEAR_CONFIRMED") ? true : null, "clear 结构化镜像");

  const emptySettings = path.join(toolsDir, "empty-settings.json");
  fs.writeFileSync(emptySettings, "{}", "utf8");
  const ordinary = spawn(FAKE_CLI, ["--session-id", EXTERNAL_SID, "--settings", emptySettings], {
    cwd, env: bridgeEnvironment, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  externalChildren.add(ordinary);
  ordinary.stdin.write("ordinary external session\n");
  await control.wait((message) => message.type === "session.list.data"
    && message.sessions.some((session) => session.sessionId === EXTERNAL_SID), "普通外部新会话进列表");
  assert(control.terminalState().currentSessionId === clearSid, "普通外部会话抢占 lease 镜像");
  const externalMirror = await evaluate(sidepanel, "document.querySelector('.message-list')?.textContent || ''");
  assert(!externalMirror.includes("ordinary external session"), "普通外部会话内容进入当前镜像");
  evidence.ordinaryExternalSessionListedWithoutTakeover = true;
  ordinary.stdin.write("exit\n");
  await waitFor(() => ordinary.exitCode !== null || ordinary.signalCode !== null ? true : null, "普通外部夹具退出");
  externalChildren.delete(ordinary);

  await sendTerminalLine(`/resume ${INITIAL_SID}`);
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === first.owned.leaseId && message.state.currentSessionId === INITIAL_SID,
  "/resume 指定会话 Hook");
  await waitFor(async () => (await evaluate(popup, "document.querySelector('.message-list')?.textContent || ''"))
    .includes("TERMINAL_RESUME_CONFIRMED") ? true : null, "resume 双视图镜像");

  await sendTerminalLine("/fork");
  const forked = await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === first.owned.leaseId && message.state.currentSessionId
    && ![INITIAL_SID, clearSid].includes(message.state.currentSessionId), "fork 新会话 Hook");
  const activeSid = forked.state.currentSessionId;
  const compactFrom = control.inbox.length;
  await sendTerminalLine("/compact");
  await control.wait((message) => control.inbox.indexOf(message) >= compactFrom
    && message.type === "terminal.state" && message.state.phase === "active"
    && message.state.currentSessionId === activeSid, "compact 保持当前会话");
  await waitFor(() => fakeEvents().some((event) => event.kind === "hook" && event.eventName === "SessionStart"
    && event.source === "compact" && event.sessionId === activeSid) ? true : null, "compact 有效 Hook 来源");
  const hookSources = fakeEvents().filter((event) => event.kind === "hook" && event.eventName === "SessionStart")
    .map((event) => ({ source: event.source, sessionId: event.sessionId }));
  for (const [source, sessionId] of [["clear", clearSid], ["resume", INITIAL_SID], ["fork", activeSid], ["compact", activeSid]]) {
    assert(hookSources.some((event) => event.source === source && event.sessionId === sessionId), `缺少 ${source} Hook 证据`);
  }
  evidence.clearResumeForkFollowedHooks = true;
  evidence.observations.sessionTransitions = { clearSid, resumedSid: INITIAL_SID, activeSid };

  for (const page of [sidepanel, popup]) {
    const compact = await waitFor(() => fixtureState(page, "compact"), "compact 折叠详情");
    assert(compact.open === false && compact.detail.includes("完整内部摘要") && !compact.leakedUser,
      "compact 摘要角色或折叠错误");
    const compactExpanded = await evaluate(page, `(() => {
      const card = [...document.querySelectorAll('.tool-card')].find(el => (el.textContent || '').includes('已压缩上下文'));
      const detail = card?.querySelector('details.status-detail'); if (!detail) return false;
      detail.querySelector('summary').click(); return detail.open;
    })()`);
    assert(compactExpanded, "compact 完整摘要不能展开");
  }

  await sendTerminalLine("/fixture task");
  for (const page of [sidepanel, popup]) {
    const task = await waitFor(() => fixtureState(page, "task"), "Task 折叠报告");
    assert(task.open === false && task.detail.includes("SUBAGENT_REPORT_START")
      && task.detail.includes("SUBAGENT_REPORT_END") && !task.leakedUser, "Task 长报告未默认折叠或冒充用户");
    const expanded = await evaluate(page, `(() => {
      const card = [...document.querySelectorAll('.tool-card')].find(el => (el.textContent || '').includes('任务已完成：task-fixture'));
      const detail = card?.querySelector('details.status-detail'); if (!detail) return false;
      detail.querySelector('summary').click(); return detail.open;
    })()`);
    assert(expanded, "Task 完整报告不能展开");
  }

  await sendTerminalLine("/fixture tools");
  const toolState = await waitFor(() => fixtureState(sidepanel, "tools"), "工具/diff/Ask 夹具");
  assert(toolState.readDetails.length === 2 && toolState.readDetails.every((item) => !item.open)
    && toolState.readDetails.some((item) => item.text.includes("COMPLETE_TOOL_OUTPUT")), "工具完整输出未折叠");
  assert(toolState.editDetails.some((item) => item.text.includes("-旧行") && item.text.includes("+新行")), "Edit diff 丢失");
  assert(toolState.ask.includes("选哪个？") && toolState.ask.includes("A"), "Ask 历史结果丢失");
  await evaluate(sidepanel, `(() => {
    const read = document.querySelector('.tool-activity[data-tool="Read"]');
    for (const detail of read?.querySelectorAll('details') ?? []) detail.querySelector('summary')?.click();
    return true;
  })()`);
  const expandedTools = await fixtureState(sidepanel, "tools");
  assert(expandedTools.readDetails.every((item) => item.open), "工具原始参数与完整输出不能展开");
  evidence.compactAndTaskCollapsedExpandable = true;
  await screenshot(sidepanel, "embedded-sidepanel-fixtures.png");
  await screenshot(popup, "embedded-popup-fixtures.png");

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
  assert(!transcriptEntries(activeSid).some((entry) => entry.message?.content === "不得双写"), "READ_ONLY 请求写入转录");
  evidence.directWritesRejected = upstreamRequests === 0;

  const other = await ControlClient.connect();
  const nonOwnerStart = other.inbox.length;
  other.send({ type: "terminal.input", leaseId: first.owned.leaseId, data: "not-owner\n" });
  other.send({ type: "terminal.resize", leaseId: first.owned.leaseId, cols: 100, rows: 30 });
  other.send({ type: "terminal.close", leaseId: first.owned.leaseId });
  const nonOwnerErrors = await waitFor(() => {
    const errors = other.inbox.slice(nonOwnerStart).filter((message) => message.type === "terminal.error"
      && message.leaseId === first.owned.leaseId);
    return errors.filter((message) => message.code === "ATTACH_REQUIRED").length === 2
      && errors.filter((message) => message.code === "NOT_OWNER").length === 1 ? errors : null;
  }, "非 owner input/resize/close 错误契约");
  evidence.observations.nonOwnerErrors = nonOwnerErrors.map((message) => message.code);
  other.close();
  assert(pidAlive(first.owned.pid), "非 owner close 杀掉了真实 PTY");
  evidence.nonOwnerControlsRejected = true;

  const terminalAttachCount = proxy.events.filter((event) => event.type === "terminal.attach").length;
  proxy.disconnectChats();
  await Promise.all([waitConnected(sidepanel, "聊天断线后 side panel 重连"), waitConnected(popup, "聊天断线后 popup 重连")]);
  assert(pidAlive(first.owned.pid), "普通聊天 WS 断开影响 owned PTY");
  assert(proxy.events.filter((event) => event.type === "terminal.attach").length === terminalAttachCount,
    "普通聊天重连错误触发终端 attach");
  evidence.chatDisconnectDoesNotKillPty = true;

  await sendTerminalLine("/ticks on");
  await delay(600);
  const forcedIndex = proxy.events.length;
  proxy.disconnectTerminal();
  const forced = proxy.events[forcedIndex];
  assert(forced?.type === "forced.disconnect", "没有登记真实终端断线");
  await delay(1400);
  const reattach = await waitFor(() => proxy.events.find((event, index) => index > forcedIndex
    && event.direction === "client" && event.type === "terminal.attach"
    && event.leaseId === first.owned.leaseId && Number.isSafeInteger(event.afterSeq)) ?? null,
  "3 秒内同 lease 重连", 2500);
  const reattachedIndex = proxy.events.findIndex((event, index) => index > forcedIndex
    && event.direction === "server" && event.type === "terminal.attached" && event.leaseId === first.owned.leaseId
    && event.at >= reattach.at);
  assert(reattachedIndex > forcedIndex, "重连后未收到 terminal.attached");
  const reattached = proxy.events[reattachedIndex];
  assert(reattached.latestSeq >= reattach.afterSeq + 2, "断线期间没有足够输出需要重放");
  const replay = await waitFor(() => {
    const seqs = proxy.events.slice(reattachedIndex + 1).filter((event) => event.direction === "server"
      && event.type === "terminal.output" && event.leaseId === first.owned.leaseId
      && event.seq > reattach.afterSeq && event.seq <= reattached.latestSeq).map((event) => event.seq);
    const unique = [...new Set(seqs)].sort((a, b) => a - b);
    return unique.length === reattached.latestSeq - reattach.afterSeq ? unique : null;
  }, "断线输出 seq 连续补齐");
  assert(replay.every((seq, index) => seq === reattach.afterSeq + index + 1), "重放 seq 存在缺口");
  evidence.replayContiguous = true;
  evidence.reconnectWithin3Seconds = reattached.at - forced.at <= 3000;
  evidence.observations.reconnect = { elapsedMs: reattached.at - forced.at, afterSeq: reattach.afterSeq,
    latestSeq: reattached.latestSeq, replayed: replay.length };
  await sendTerminalLine("/ticks off");

  const systemRejectedFrom = control.inbox.length;
  control.send({ type: "terminal.open", mode: "system" });
  await control.wait((message) => control.inbox.indexOf(message) >= systemRejectedFrom
    && message.type === "terminal.error" && message.code === "ALREADY_ACTIVE", "embedded 期间拒绝系统终端");
  assert(pidAlive(first.owned.pid) && !fs.existsSync(path.join(home, "terminal", "system-lease.json")),
    "互斥拒绝影响 embedded lease");
  evidence.observations.embeddedRejectedSystem = true;

  const closeFrom = control.inbox.length;
  const proxyCloseFrom = proxy.events.length;
  const clickedStop = await evaluate(terminalPage, `(() => {
    const button = document.querySelector('.terminal-stop'); if (!button || button.disabled) return false;
    button.click(); return true;
  })()`);
  assert(clickedStop, "真实结束终端按钮不可点击");
  await waitFor(() => proxy.events.some((event, index) => index > proxyCloseFrom
    && event.direction === "server" && event.type === "terminal.exit"
    && event.leaseId === first.owned.leaseId) ? true : null, "结束按钮等待 owner 连接真实 exit");
  await waitPidExit(first.owned.pid);
  await control.wait((message) => control.inbox.indexOf(message) >= closeFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "结束按钮恢复 idle");
  const closeTail = control.inbox.slice(closeFrom);
  const mirrorIndex = closeTail.findIndex((message) => message.type === "session.mirror.data" && message.sessionId === activeSid);
  const restoreIndex = closeTail.findIndex((message) => message.type === "folder.bound" && message.sessionId === activeSid);
  const idleIndex = closeTail.findIndex((message) => message.type === "terminal.state" && message.state.phase === "idle");
  assert(mirrorIndex >= 0 && restoreIndex > mirrorIndex && idleIndex > restoreIndex, "最终镜像/恢复/idle 顺序错误");
  await waitFor(async () => (await evaluate(terminalPage, "document.querySelector('.terminal-phase')?.textContent || ''"))
    .includes("终端已退出") ? true : null, "终端页显示真实退出");
  const exitRecord = JSON.parse(fs.readFileSync(path.join(home, "terminal", `${first.owned.leaseId}.exit.json`), "utf8"));
  assert(exitRecord.leaseId === first.owned.leaseId && exitRecord.reason === "exit", "缺少真实 PTY 退出文件");
  evidence.observations.firstExitFile = { leaseId: exitRecord.leaseId, reason: exitRecord.reason, exitCode: exitRecord.exitCode };
  await verifyReadonly(false);
  evidence.closeButtonRestoresLastHookSession = true;
  await closeTerminalTarget();

  const system = await openFromSidepanel("windows-terminal");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === system.state.leaseId, "系统终端 SessionStart");
  const embeddedRejectedFrom = control.inbox.length;
  control.send({ type: "terminal.open", mode: "embedded" });
  await control.wait((message) => control.inbox.indexOf(message) >= embeddedRejectedFrom
    && message.type === "terminal.error" && message.code === "ALREADY_ACTIVE", "系统终端期间拒绝 embedded");
  evidence.systemAndEmbeddedMutuallyExclusive = evidence.observations.embeddedRejectedSystem === true;
  const systemExitFrom = control.inbox.length;
  sendTracked(system.handle, "exit");
  await control.wait((message) => control.inbox.indexOf(message) >= systemExitFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "系统终端真实退出");
  if (listWindows().some((item) => item.handle === String(system.handle))) await closeTracked(system.handle);
  else { terminalWindows.delete(system.handle); terminalConsolePids.delete(system.handle); }
  await verifyReadonly(false);

  const newSessionFrom = control.inbox.length;
  control.send({ type: "session.new" });
  await control.wait((message) => control.inbox.indexOf(message) >= newSessionFrom
    && message.type === "folder.bound" && message.sessionId === null, "无会话工作区");
  const second = await openFreshEmbedded(null);
  const generatedSid = control.terminalState().currentSessionId;
  const generatedStart = fakeEvents().find((event) => event.kind === "start" && event.pid === second.owned.pid);
  evidence.noSessionUsesGeneratedUuid = /^[0-9a-f-]{36}$/.test(generatedSid ?? "")
    && generatedStart?.resumeArg === null && generatedStart?.sessionIdArg === generatedSid;
  assert(evidence.noSessionUsesGeneratedUuid, "无会话启动未使用桥接生成的 --session-id UUID");
  evidence.observations.noSession = { leaseId: second.owned.leaseId, sessionId: generatedSid };

  // 超过 3 秒仍无法重连：保持页面打开，只阻断 WS，真实 PTY 必须由宽限计时器清理。
  const timeoutIdleFrom = control.inbox.length;
  const timeoutStartedAt = Date.now();
  proxy.rejectConnections = true;
  try {
    proxy.disconnectTerminal();
    await waitPidExit(second.owned.pid);
  } finally {
    proxy.rejectConnections = false;
  }
  const timeoutElapsed = Date.now() - timeoutStartedAt;
  assert(timeoutElapsed >= 2800, `重连宽限未经过约 3 秒就清理 PTY：${timeoutElapsed}ms`);
  await control.wait((message) => control.inbox.indexOf(message) >= timeoutIdleFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "重连超时恢复 idle");
  evidence.observations.reconnectTimeout = { elapsedMs: timeoutElapsed, leaseId: second.owned.leaseId };
  evidence.reconnectAfter3SecondsKillsOwnedPty = true;
  await closeTerminalTarget();
  await Promise.all([waitConnected(sidepanel, "超时后 side panel 重连"), waitConnected(popup, "超时后 popup 重连")]);
  await verifyReadonly(false);

  // 刷新会销毁原 attachToken；旧 PTY 退出，新文档只能创建新 lease，不能恢复旧屏幕。
  const third = await openFreshEmbedded(generatedSid);
  const refreshFrom = proxy.events.length;
  const refreshIdleFrom = control.inbox.length;
  await terminalPage.send("Page.reload", { ignoreCache: true });
  await waitPidExit(third.owned.pid);
  const refreshedOpened = await waitFor(() => proxy.events.find((event, index) => index >= refreshFrom
    && event.direction === "server" && event.type === "terminal.opened"
    && event.leaseId !== third.owned.leaseId) ?? null, "刷新后新文档重新 open");
  const refreshed = await trackEmbeddedProcess(third.owned.leaseId);
  assert(refreshed.leaseId === refreshedOpened.leaseId && refreshed.leaseId !== third.owned.leaseId,
    "刷新错误复用旧 lease");
  await waitFor(async () => (await evaluate(terminalPage, "document.querySelector('.terminal-phase')?.textContent || ''"))
    .includes("终端已连接") ? true : null, "刷新后的新终端 attached");
  await control.wait((message) => control.inbox.indexOf(message) >= refreshIdleFrom
    && message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === refreshed.leaseId && message.state.currentSessionId === generatedSid,
  "刷新后新 lease 的有效 Hook");
  assert(!proxy.events.slice(refreshFrom).some((event) => event.direction === "client"
    && event.type === "terminal.attach" && event.leaseId === third.owned.leaseId), "刷新后旧 attachToken 被重新使用");
  evidence.observations.refresh = { oldLeaseId: third.owned.leaseId, newLeaseId: refreshed.leaseId };
  evidence.refreshCannotReuseAttachToken = true;
  await verifyReadonly(true);

  // 代理只丢弃一个真实输出块；后续 seq 到达后，页面必须明示缺口并结束自己拥有的 PTY。
  await sendTerminalLine("/ticks on");
  await delay(600);
  const gapFrom = proxy.events.length;
  const gapIdleFrom = control.inbox.length;
  proxy.dropNextOutput = true;
  await waitFor(() => proxy.droppedOutputSeq !== null ? true : null, "真实丢弃一个 terminal.output");
  await waitFor(async () => (await evaluate(terminalPage, "document.querySelector('.terminal-phase')?.textContent || ''"))
    .includes("输出序号不连续") ? true : null, "页面显示输出序号缺口");
  await screenshot(terminalPage, "embedded-output-gap.png");
  await waitPidExit(refreshed.pid);
  await control.wait((message) => control.inbox.indexOf(message) >= gapIdleFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "输出缺口后恢复 idle");
  assert(proxy.events.slice(gapFrom).some((event) => event.direction === "client"
    && event.type === "terminal.close" && event.leaseId === refreshed.leaseId), "输出缺口未发送定向 close");
  evidence.observations.outputGap = { leaseId: refreshed.leaseId, droppedSeq: proxy.droppedOutputSeq };
  evidence.outputGapVisibleAndCloses = true;
  await closeTerminalTarget();
  await verifyReadonly(false);

  const fourth = await openFreshEmbedded(generatedSid);
  await closeEmbeddedAndWait(fourth.owned);
  evidence.pagehideClosesOwnedPty = true;
  await verifyReadonly(false);

  // 定向 WM_CLOSE 必须经过 server.close()；强杀只用于后续异常恢复夹具，不能冒充正常关闭。
  const fifth = await openFreshEmbedded(generatedSid);
  await stopBridge(true);
  await waitPidExit(fifth.owned.pid);
  evidence.observations.bridgeShutdown = { leaseId: fifth.owned.leaseId, pid: fifth.owned.pid };
  evidence.bridgeShutdownKillsOwnedPty = true;
  await closeTerminalTarget();
  await startBridge();
  await Promise.all([waitConnected(sidepanel, "正常重启后 side panel 重连"), waitConnected(popup, "正常重启后 popup 重连")]);
  await bindCurrentSession(generatedSid);
  await verifyReadonly(false);

  // Windows 强杀 ConPTY owner 后，客户端可随 master 退出且没有 exit 文件；明确 ESRCH 时最终同步，不猜杀 PID。
  const sixth = await openFreshEmbedded(generatedSid);
  await stopBridge();
  await waitPidExit(sixth.owned.pid);
  assert(!fs.existsSync(path.join(home, "terminal", `${sixth.owned.leaseId}.exit.json`)),
    "异常 ConPTY 场景意外存在 exit 文件，无法覆盖 PID 已退出恢复分支");
  await closeTerminalTarget();
  await startBridge();
  const exitedRecoveryIdleFrom = control.inbox.length;
  await waitFor(() => !fs.existsSync(path.join(home, "terminal", "embedded-lease.json")) ? true : null,
    "ConPTY 已退出 recover 清除私有 lease");
  await control.wait((message) => control.inbox.indexOf(message) >= exitedRecoveryIdleFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "ConPTY 已退出 recover 的新 idle");
  evidence.observations.exitedConptyRecovery = { leaseId: sixth.owned.leaseId, pid: sixth.owned.pid };
  evidence.abnormalRestartClearsExitedConpty = true;
  await Promise.all([waitConnected(sidepanel, "ConPTY 退出恢复后 side panel 重连"), waitConnected(popup, "ConPTY 退出恢复后 popup 重连")]);
  await bindCurrentSession(generatedSid);
  await verifyReadonly(false);

  // 真实 ConPTY 不留存活客户端，因此用独立 Node 进程做明确故障注入，验证身份匹配时只结束登记目标。
  const matchedBase = await openFreshEmbedded(generatedSid);
  await stopBridge();
  await waitPidExit(matchedBase.owned.pid);
  await closeTerminalTarget();
  const matchedSurvivor = await startRecoverySurvivor("matched");
  injectRecoveryIdentity(matchedBase.owned.leaseId, matchedSurvivor);
  await startBridge();
  const matchedRecoveryIdleFrom = control.inbox.length;
  await waitPidExit(matchedSurvivor.pid);
  await waitFor(() => !fs.existsSync(path.join(home, "terminal", "embedded-lease.json")) ? true : null,
    "身份匹配 recover 清除私有 lease");
  await control.wait((message) => control.inbox.indexOf(message) >= matchedRecoveryIdleFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "身份匹配 recover 的新 idle");
  evidence.observations.matchedRecovery = {
    leaseId: matchedBase.owned.leaseId, conptyPid: matchedBase.owned.pid, survivorPid: matchedSurvivor.pid,
  };
  evidence.matchedIdentityRecoveryKillsOnlyOwnedPty = true;
  await Promise.all([waitConnected(sidepanel, "匹配恢复后 side panel 重连"), waitConnected(popup, "匹配恢复后 popup 重连")]);
  await bindCurrentSession(generatedSid);
  await verifyReadonly(false);

  // 另一个真实存活进程只篡改隔离记录中的启动时间；unknown 与人工解除都不得结束它。
  const seventh = await openFreshEmbedded(generatedSid);
  await stopBridge();
  await waitPidExit(seventh.owned.pid);
  await closeTerminalTarget();
  const unknownSurvivor = await startRecoverySurvivor("unknown");
  injectRecoveryIdentity(seventh.owned.leaseId, unknownSurvivor, true);
  await startBridge();
  const unknownState = await control.wait((message) => message.type === "terminal.state"
    && message.state.phase === "degraded" && message.state.leaseId === seventh.owned.leaseId
    && message.state.canManualRelease === true, "unknown 身份只读屏障");
  assert(pidAlive(unknownSurvivor.pid), "unknown 身份被 recover 猜杀");
  await Promise.all([waitConnected(sidepanel, "unknown 后 side panel 重连"), waitConnected(popup, "unknown 后 popup 重连")]);
  await verifyReadonly(true);
  const releaseFrom = control.inbox.length;
  control.send({ type: "terminal.release", leaseId: seventh.owned.leaseId, confirmedClosed: true });
  await control.wait((message) => control.inbox.indexOf(message) >= releaseFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "unknown 人工解除恢复 idle");
  assert(pidAlive(unknownSurvivor.pid), "人工解除错误杀掉 unknown 进程");
  evidence.observations.unknownRecovery = {
    leaseId: unknownState.state.leaseId, survivorPid: unknownSurvivor.pid, survivedManualRelease: true,
  };
  evidence.abnormalRestartNeverKillsUnknownIdentity = true;
  await verifyReadonly(false);
  const unknownActual = processIdentity(unknownSurvivor.pid);
  assert(unknownActual && unknownActual.executable.toLowerCase() === unknownSurvivor.identity.executable.toLowerCase()
    && Date.parse(unknownActual.startedAt) === Date.parse(unknownSurvivor.identity.startedAt), "定向清理前身份复核失败");
  process.kill(unknownSurvivor.pid); // 只清理本轮登记且刚刚重新核对身份的隔离故障注入进程。
  await waitPidExit(unknownSurvivor.pid);

  // 用复制过滤制造缺 manifest 的独立发行副本；不删除或改写任何已有证据文件。
  await stopBridge(true);
  const nativeAppDir = path.join(root, "native-app-without-manifest");
  const sourceManifest = path.resolve(DIST_DIR, "pty-manifest.json");
  fs.cpSync(DIST_DIR, nativeAppDir, {
    recursive: true, force: false, errorOnExist: true,
    filter: (source) => path.resolve(source) !== sourceManifest,
  });
  const nativeTerminalExe = path.join(nativeAppDir, "ccc-terminal.exe");
  assert(!fs.existsSync(path.join(nativeAppDir, "pty-manifest.json")), "原生失败副本仍含 manifest");
  await startBridge({}, nativeTerminalExe);
  await Promise.all([waitConnected(sidepanel, "原生失败后 side panel 重连"), waitConnected(popup, "原生失败后 popup 重连")]);
  await bindCurrentSession(generatedSid);
  await verifyReadonly(false);

  const nativeProxyFrom = proxy.events.length;
  const nativeIdleFrom = control.inbox.length;
  const nativeClicked = await evaluate(sidepanel, `(() => {
    const menu = document.querySelector('details.terminal-menu');
    const button = document.querySelector('button[aria-label="在插件终端打开并继续当前会话"]');
    if (!menu || !button || button.disabled) return false;
    menu.open = true; button.click(); return true;
  })()`);
  assert(nativeClicked, "原生失败场景的插件终端按钮不可点击");
  const nativeTarget = await waitFor(async () => (await targets()).find((item) => item.url.startsWith(TERMINAL_PAGE_URL)
    && item.webSocketDebuggerUrl) ?? null, "原生失败独立终端 target");
  await registerTerminalTarget(nativeTarget);
  await waitFor(() => proxy.events.slice(nativeProxyFrom).some((event) => event.direction === "server"
    && event.type === "terminal.error" && event.code === "PTY_UNAVAILABLE") ? true : null,
  "真实缺 manifest 返回 PTY_UNAVAILABLE");
  await waitFor(async () => (await evaluate(terminalPage, "document.querySelector('.terminal-phase')?.textContent || ''"))
    .includes("当前安装无法启动内嵌终端") ? true : null, "原生失败在终端页明确可见");
  await control.wait((message) => control.inbox.indexOf(message) >= nativeIdleFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "原生失败恢复 idle");
  await verifyReadonly(false);
  await screenshot(terminalPage, "embedded-native-unavailable.png");
  await closeTerminalTarget();

  // 原生内嵌后端失败不能拖垮系统终端；仍通过真实按钮、可见窗口和 exit 验证。
  const nativeSystem = await openFromSidepanel("windows-terminal");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === nativeSystem.state.leaseId, "原生失败后系统终端 SessionStart");
  evidence.observations.nativeSystemWindow = captureTerminal(nativeSystem.handle, "embedded-system-terminal.png");
  const nativeSystemExitFrom = control.inbox.length;
  const nativeSdkStartCount = fakeEvents().filter((event) => event.kind === "start").length;
  sendTracked(nativeSystem.handle, "exit");
  await control.wait((message) => control.inbox.indexOf(message) >= nativeSystemExitFrom
    && message.type === "terminal.state" && message.state.phase === "idle", "原生失败后系统终端真实退出");
  if (listWindows().some((item) => item.handle === String(nativeSystem.handle))) await closeTracked(nativeSystem.handle);
  else { terminalWindows.delete(nativeSystem.handle); terminalConsolePids.delete(nativeSystem.handle); }
  await verifyReadonly(false);

  // 系统终端退出会同步恢复 SDK Query；后续聊天复用该进程，不要求无意义地另起 CLI。
  const nativeChatStart = await waitFor(() => fakeEvents().filter((event) => event.kind === "start")
    .slice(nativeSdkStartCount).find((event) => event.resumeArg === generatedSid) ?? null,
  "系统终端退出后恢复隔离 SDK CLI");
  const nativeChatIdentity = await waitFor(() => processIdentity(nativeChatStart.pid), "登记原生失败聊天进程身份");
  ownedProcesses.set(nativeChatStart.pid, { role: "chat", ...nativeChatIdentity });
  const chatFrom = control.inbox.length;
  const chatEventFrom = fakeEvents().length;
  control.send({ type: "chat.send", text: "NATIVE_FAILURE_CHAT_ACCEPTED" });
  await waitFor(() => fakeEvents().slice(chatEventFrom).find((event) => event.kind === "chat"
    && event.pid === nativeChatStart.pid && event.sessionId === generatedSid
    && event.marker === "NATIVE_FAILURE_CHAT_ACCEPTED") ?? null,
  "同一恢复 SDK 进程收到普通聊天");
  await control.wait((message) => control.inbox.indexOf(message) >= chatFrom
    && message.type === "chat.delta" && message.text === "NATIVE_FAILURE_CHAT_REPLY", "原生失败后聊天真实流式回复");
  await control.wait((message) => control.inbox.indexOf(message) >= chatFrom
    && message.type === "chat.done", "原生失败后聊天真实完成");
  assert(!control.inbox.slice(chatFrom).some((message) => message.type === "terminal.error"
    && message.code === "READ_ONLY"), "原生失败后聊天仍被 READ_ONLY 阻止");
  await waitFor(() => {
    const entries = transcriptEntries(generatedSid);
    const user = entries.some((entry) => entry.type === "user" && entry.message?.content === "NATIVE_FAILURE_CHAT_ACCEPTED");
    const assistant = entries.some((entry) => entry.type === "assistant" && entry.message?.content?.some?.(
      (block) => block.type === "text" && block.text === "NATIVE_FAILURE_CHAT_REPLY"));
    return user && assistant ? true : null;
  }, "原生失败后聊天请求与回复写入隔离转录");
  evidence.observations.nativeFailure = {
    ptyUnavailable: true, systemTerminalExited: true, chatAccepted: true, chatCompleted: true,
    reusedRestoredSdk: true, chatPid: nativeChatStart.pid,
  };
  evidence.nativeFailureLeavesChatAndSystemTerminalUsable = true;
  await stopBridge(true);
  await waitPidExit(nativeChatStart.pid);
  await closeTerminalTarget();

  const hookFailures = fakeEvents().filter((event) => event.kind === "hook-helper-stderr" || event.kind === "hook-error");
  evidence.observations.hookFailures = hookFailures.map((event) => ({
    kind: event.kind, eventName: event.eventName, sessionId: event.sessionId,
  }));
  evidence.commandHooksWithoutFailure = hookFailures.length === 0;
  evidence.observations.upstreamRequests = upstreamRequests;
  assert(upstreamRequests === 0, `隔离验收调用了真实上游：${upstreamRequests} 次`);
  evidence.runtimeErrors = pages.flatMap((page) => page.errors.map((item) => ({ page: page.label, error: item })));
  assertRequiredEvidence();
  evidence.ok = true;
}

/** @returns 当前真实 CLI 会话的完整隔离转录文本 */
function realTranscriptText() {
  const file = path.join(claudeConfig, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"), `${INITIAL_SID}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * 等待真实终端续聊请求、同 sessionId 转录和两个插件视图镜像。
 * @param {"embedded"|"system"} stage 终端类型
 * @param {string} userMarker 本轮用户固定标记
 * @param {string} assistantMarker 本轮助手固定标记
 * @returns {Promise<Record<string, unknown>>} 脱敏请求证据
 */
async function waitRealCliTurn(stage, userMarker, assistantMarker) {
  const request = await waitFor(() => realUpstream?.requests.find((item) => item.stage === stage
    && item.hasOriginalUser === true && item.hasOriginalAssistant === true) ?? null,
  `${stage} 真实 CLI 请求携带首轮用户与助手上下文`, 45000);
  assert(request.messageCount >= 4, `${stage} 恢复后的消息数未包含历史`);
  await waitFor(() => [REAL_MARKERS.initialUser, REAL_MARKERS.initialAssistant, userMarker, assistantMarker]
    .every((marker) => realTranscriptText().includes(marker)) ? true : null,
  `${stage} 两轮内容写入同一真实 JSONL`, 20000);
  for (const [label, page] of [["sidepanel", sidepanel], ["popup", popup]]) {
    await waitFor(async () => evaluate(page, `(() => {
      const text = document.querySelector('.message-list')?.textContent || '';
      return text.includes(${JSON.stringify(userMarker)}) && text.includes(${JSON.stringify(assistantMarker)});
    })()`) ? true : null, `${stage} 真实转录镜像到 ${label}`, 20000);
  }
  return request;
}

/** @returns 无返回值；无选区 Ctrl+C 必须中止真实进行中请求，且 CLI 随后可继续 */
async function verifyRealCliInterrupt() {
  assert(realInterruptUpstream, "真实 CLI 中断代理未启动");
  const proxyStart = proxy.events.length;
  await sendTerminalLine(REAL_MARKERS.interruptUser);
  await waitFor(() => realInterruptUpstream.delayed >= 1 ? true : null, "真实 CLI 进行中请求已延迟", 15000);
  const point = await evaluate(terminalPage, `(() => {
    const rect = document.querySelector('.terminal-xterm')?.getBoundingClientRect();
    return rect ? { x: rect.right - 12, y: rect.bottom - 12 } : null;
  })()`);
  assert(point, "无法定位真实 xterm 清除选区");
  await mouseTerminal(point, true);
  await mouseTerminal(point, false);
  await dispatchTerminalKey("c", true, false);
  await waitFor(() => realInterruptUpstream.aborted >= 1 ? true : null, "Ctrl+C 中止真实上游请求", 12000);
  await waitFor(() => proxy.events.some((event, index) => index >= proxyStart
    && event.direction === "client" && event.type === "terminal.input" && event.inputKind === "ctrl-c")
    ? true : null, "无选区 Ctrl+C 进入真实 PTY", 3000);
  const embeddedRequests = realUpstream.requests.filter((item) => item.stage === "embedded").length;
  const assistantOccurrences = realTranscriptText().split("REAL_CLI_EMBEDDED_ASSISTANT").length - 1;
  await sendTerminalLine(REAL_MARKERS.embeddedUser);
  await waitFor(() => realUpstream.requests.filter((item) => item.stage === "embedded").length > embeddedRequests
    ? true : null, "中断后真实 CLI 发起下一轮", 20000);
  await waitFor(() => realTranscriptText().split("REAL_CLI_EMBEDDED_ASSISTANT").length - 1 > assistantOccurrences
    ? true : null, "中断后真实 CLI 回复写入同一转录", 20000);
  evidence.realCliCtrlCInterruptedRequest = true;
  evidence.observations.realCliInterrupt = {
    delayedRequests: realInterruptUpstream.delayed, abortedRequests: realInterruptUpstream.aborted,
    continuedAfterInterrupt: true,
  };
}

/** @returns 无返回值；验证真实 CLI 导出原生 scrollback，且真实滚轮移动视口 */
async function verifyRealCliHistoryWheel() {
  await verifyTerminalToolbar();
  const metrics = () => evaluate(terminalPage, `(() => {
    const viewport = document.querySelector('.xterm-viewport');
    return viewport ? { height: viewport.scrollHeight, top: viewport.scrollTop } : null;
  })()`);
  const before = await metrics();
  assert(before, "无法读取导出前的真实 xterm 视口");
  const proxyStart = proxy.events.length;
  await clickTerminalToolbarButton("可滚历史");
  await waitFor(() => proxy.events.some((event, index) => index >= proxyStart
    && event.direction === "client" && event.type === "terminal.input" && event.inputKind === "ctrl-o")
    ? true : null, "真实 Ctrl+O 已进入 PTY", 5000);
  await waitFor(() => proxy.events.some((event, index) => index >= proxyStart
    && event.direction === "client" && event.type === "terminal.input" && event.inputKind === "history-export-bracket")
    ? true : null, "真实 transcript 检测后发送导出键", 5000);
  await waitFor(async () => (await evaluate(terminalPage,
    "document.querySelector('.terminal-action-status')?.textContent || ''")).includes("已发送导出")
    ? true : null, "真实历史导出反馈", 5000);
  const exported = await waitFor(async () => {
    const current = await metrics();
    return current && current.height > before.height ? current : null;
  }, "真实 CLI 导出后原生 scrollback 增长", 10000);
  evidence.realCliHistoryExportScrollback = true;
  const center = await evaluate(terminalPage, `(() => {
    const rect = document.querySelector('.xterm-viewport')?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert(center, "无法定位真实 xterm 滚轮区域");

  /** 真实滚轮只操作 xterm 原生视口，不应向 PTY 发送方向键。 */
  const wheel = async (deltaY, direction, label) => {
    const inputStart = proxy.events.length;
    const previous = await metrics();
    assert(previous, `无法读取${label}前视口`);
    await terminalPage.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY });
    const current = await waitFor(async () => {
      const next = await metrics();
      return next && (direction < 0 ? next.top < previous.top : next.top > previous.top) ? next : null;
    }, `${label}后原生视口移动`, 8000);
    assert(!proxy.events.some((event, index) => index >= inputStart && event.direction === "client"
      && event.type === "terminal.input" && ["arrow-up", "arrow-down", "history-wheel-up", "history-wheel-down"]
        .includes(event.inputKind)), `${label}不应向真实 PTY 发送滚动按键`);
    return { before: previous.top, after: current.top };
  };
  const up = await wheel(-720, -1, "向上滚轮");
  await screenshot(terminalPage, "real-cli-history-wheel.png");
  const down = await wheel(720, 1, "向下滚轮");
  evidence.realCliWheelScrollsExportedHistory = up.after < up.before && down.after > down.before;
  evidence.observations.realCliHistoryWheel = {
    exportBracketSent: true, heightBefore: before.height, heightAfter: exported.height,
    wheelUp: up, wheelDown: down,
  };
  assert(evidence.realCliWheelScrollsExportedHistory, "真实 CLI 导出历史后滚轮未移动原生视口");
}

/**
 * 在隔离 xterm 中按真实画面完成首次向导；只有目标 lease 已进入会话才停止轮询。
 * @param {string} leaseId 本轮插件终端的私有租约 ID
 * @returns {Promise<void>} 已进入会话或全部可见向导处理完后 resolves
 */
async function completeRealCliOnboarding(leaseId) {
  const readText = () => evaluate(terminalPage, "document.querySelector('.xterm-rows')?.textContent || ''");
  const waitSelection = (needle, label) => waitFor(async () => evaluate(terminalPage, `(() => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')].map(el => el.textContent || '');
    const row = rows.find(text => text.includes(${JSON.stringify(needle)}));
    return row && row.includes('❯') ? row : null;
  })()`), label, 4000);
  const sendArrow = async (direction) => {
    const code = direction === "ArrowUp" ? 38 : 40;
    await terminalPage.send("Page.bringToFront");
    await evaluate(terminalPage, "document.querySelector('.xterm-helper-textarea')?.focus(); true");
    await terminalPage.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: direction, code: direction, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
    await terminalPage.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: direction, code: direction, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
    });
  };
  const state = {
    themePromptSeen: false, trustPromptSeen: false, apiKeyPromptSeen: false, securityNotesSeen: false,
    themeConfirmed: false, apiKeyConfirmed: false, trustConfirmed: false, securityNotesConfirmed: false,
    activeHookSeen: false,
  };
  const active = () => {
    const current = control.terminalState();
    return current?.phase === "active" && current.leaseId === leaseId
      && current.currentSessionId === INITIAL_SID;
  };
  evidence.observations.realCliOnboarding = state;
  const deadline = Date.now() + 45000;
  let lastScreen = "unread";
  while (Date.now() < deadline) {
    if (active()) { state.activeHookSeen = true; return; }
    const text = await readText();
    if (text) lastScreen = text.includes("Choose the text style") ? "theme"
      : text.includes("Do you want to use this API key?") ? "api-key"
        : text.includes("Security notes:") ? "security-notes"
          : text.includes("Yes, I trust this folder") ? "trust" : "session-or-other";
    if (text.includes("Choose the text style") && !state.themeConfirmed) {
      state.themePromptSeen = true;
      await sendTerminalLine("");
      state.themeConfirmed = true;
      continue;
    }
    if (text.includes("Do you want to use this API key?") && !state.apiKeyConfirmed) {
      state.apiKeyPromptSeen = true;
      // 隔离 dummy key 默认选 No；确认 Yes 行出现选择光标后才按 Enter。
      await sendArrow("ArrowUp");
      await waitSelection("Yes", "隔离 API key 向导已选择 Yes");
      await sendTerminalLine("");
      state.apiKeyConfirmed = true;
      continue;
    }
    if (text.includes("Security notes:") && text.includes("Press Enter to continue")
      && !state.securityNotesConfirmed) {
      state.securityNotesSeen = true;
      await sendTerminalLine("");
      state.securityNotesConfirmed = true;
      continue;
    }
    if (text.includes("Yes, I trust this folder") && !state.trustConfirmed) {
      state.trustPromptSeen = true;
      // 只信任本轮新建且为空的隔离 cwd，并先确认目标选项已被选中。
      await sendArrow("ArrowDown");
      await waitSelection("Yes, I trust this folder", "目录信任向导已选择 Yes");
      await sendTerminalLine("");
      state.trustConfirmed = true;
      continue;
    }
    await delay(100);
  }
  throw new Error(`真实 CLI 首次向导等待超时；最后画面分类=${lastScreen}`);
}

/**
 * 只在隔离配置中预置首次初始化结果，避免把 CLI 自带向导当作终端 resume 的验收对象。
 * @param {string} cliVersion 真实 CLI 版本输出
 * @returns {void}
 * @throws {SyntaxError} 隔离 CLI 配置不是合法 JSON 时抛出
 */
function prepareRealCliOnboarding(cliVersion) {
  const configFile = path.join(claudeConfig, ".claude.json");
  assert(inside(root, configFile), "拒绝修改隔离目录外的 CLI 配置");
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
  const responses = config.customApiKeyResponses && typeof config.customApiKeyResponses === "object"
    ? config.customApiKeyResponses : {};
  config.hasCompletedOnboarding = true;
  config.lastOnboardingVersion = cliVersion.trim().split(/\s+/, 1)[0] || "unknown";
  config.customApiKeyResponses = {
    ...responses,
    approved: [...new Set([...(Array.isArray(responses.approved) ? responses.approved : []), "mock-local-only"])],
    rejected: Array.isArray(responses.rejected) ? responses.rejected : [],
  };
  config.projects = config.projects && typeof config.projects === "object" ? config.projects : {};
  // CLI 2.1.316 在 Windows 的 .claude.json projects 中使用正斜杠绝对路径作为键。
  const projectKey = cwd.replaceAll("\\", "/");
  config.projects[projectKey] = {
    ...(config.projects[projectKey] && typeof config.projects[projectKey] === "object" ? config.projects[projectKey] : {}),
    hasTrustDialogAccepted: true,
    hasTrustDialogHooksAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  evidence.realCliOnboardingPreseeded = true;
}

/** 真实 Claude Code CLI + 真实 Chrome/双终端的定向 resume 补验。 */
async function runRealCliResume() {
  assert(realCliPath, "真实 CLI 路径为空");
  realUpstream = await startRealCliUpstream(REAL_MARKERS);
  const version = spawnSync(realCliPath, ["--version"], { encoding: "utf8", windowsHide: true });
  const initial = await runRealCli(realCliPath, [
    "--session-id", INITIAL_SID, "-p", REAL_MARKERS.initialUser, "--output-format", "json",
  ], cwd, realCliEnvironment());
  assert(initial.code === 0 && !initial.timedOut && initial.stdout.includes(REAL_MARKERS.initialAssistant),
    `真实 CLI 首轮建会话失败：${initial.stderr.slice(-1000)} ${initial.stdout.slice(-1000)}`);
  evidence.realCliInitialSessionCreated = [REAL_MARKERS.initialUser, REAL_MARKERS.initialAssistant]
    .every((marker) => realTranscriptText().includes(marker));
  assert(evidence.realCliInitialSessionCreated, "真实 CLI 首轮转录未创建");
  prepareRealCliOnboarding(version.status === 0 ? version.stdout : "unknown");
  realInterruptUpstream = await startRealCliInterruptProxy();

  proxy = await VerificationProxy.listen();
  await startBridge();
  control.send({ type: "folder.bind", path: cwd, reset: true });
  await control.wait((message) => message.type === "folder.bound" && message.path === cwd, "真实 CLI 绑定隔离文件夹");
  control.send({ type: "session.switch", sessionId: INITIAL_SID });
  const bound = await control.wait((message) => message.type === "folder.bound"
    && message.path === cwd && message.sessionId === INITIAL_SID, "真实 CLI 选择既有会话");
  assert(bound.resumed === true, "既有真实转录未被识别为可续聊");
  await startChrome();
  await evaluate(sidepanel, `(() => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'DRAFT_BEFORE_TERMINAL');
    input.dispatchEvent(new Event('input', { bubbles: true })); return true;
  })()`);
  await waitFor(() => popup && readReadonly(popup, false).then((state) => state.draft === "DRAFT_BEFORE_TERMINAL" ? true : null),
    "真实 CLI 草稿同步双视图");

  const embedded = await openEmbeddedWindow();
  await completeRealCliOnboarding(embedded.owned.leaseId);
  const onboarding = evidence.observations.realCliOnboarding;
  evidence.realCliOnboardingSkipped = onboarding.activeHookSeen === true
    && !onboarding.themePromptSeen && !onboarding.apiKeyPromptSeen
    && !onboarding.securityNotesSeen && !onboarding.trustPromptSeen;
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === embedded.owned.leaseId && message.state.currentSessionId === INITIAL_SID,
  "插件终端真实 SessionStart(resume) Hook", 30000);
  evidence.realCliEmbeddedResumeStarted = embedded.state.initialSessionId === INITIAL_SID;
  await verifyReadonly(true);
  await delay(1500);
  await sendTerminalLine(REAL_MARKERS.embeddedUser);
  const embeddedRequest = await waitRealCliTurn("embedded", REAL_MARKERS.embeddedUser, REAL_MARKERS.embeddedAssistant);
  evidence.realCliEmbeddedContextRestored = true;
  evidence.realCliEmbeddedMirrorUpdated = true;
  await screenshot(terminalPage, "real-cli-embedded-resume.png");
  await verifyRealCliInterrupt();
  await verifyRealCliHistoryWheel();
  await closeEmbeddedAndWait(embedded.owned);
  await verifyReadonly(false);
  evidence.realCliEmbeddedExitRestored = true;

  const system = await openFromSidepanel("windows-terminal");
  await control.wait((message) => message.type === "terminal.state" && message.state.phase === "active"
    && message.state.leaseId === system.state.leaseId && message.state.currentSessionId === INITIAL_SID,
  "系统终端真实 SessionStart(resume) Hook", 30000);
  evidence.realCliSystemResumeStarted = system.state.initialSessionId === INITIAL_SID;
  await verifyReadonly(true);
  await delay(1500);
  sendTracked(system.handle, REAL_MARKERS.systemUser);
  const systemRequest = await waitRealCliTurn("system", REAL_MARKERS.systemUser, REAL_MARKERS.systemAssistant);
  evidence.realCliSystemContextRestored = true;
  evidence.realCliSystemMirrorUpdated = true;
  evidence.observations.realCliSystemWindow = captureTerminal(system.handle, "real-cli-system-resume.png");
  const systemPid = terminalConsolePids.get(system.handle);
  assert(Number.isInteger(systemPid) && systemPid > 0, "真实系统终端包装 PID 未登记");
  const systemExitFrom = control.inbox.length;
  await closeTracked(system.handle);
  await observeSystemWindowClose(system.state.leaseId, systemPid);
  await control.wait((message) => control.inbox.indexOf(message) >= systemExitFrom
    && message.type === "terminal.state" && message.state.phase === "idle",
  "真实系统终端窗口关闭后的新 idle", 30000);
  await verifyReadonly(false);
  evidence.realCliSystemExitRestored = true;

  await stopBridge(true);
  evidence.realCliBridgeShutdownClean = !fs.existsSync(path.join(home, "runtime.json"));
  evidence.observations.realCli = {
    version: version.status === 0 ? version.stdout.trim() : "unknown",
    sessionId: INITIAL_SID,
    requests: realUpstream.requests,
    embeddedRequest,
    systemRequest,
  };
  evidence.observations.upstreamRequests = realUpstream.requests.length;
  evidence.runtimeErrors = pages.flatMap((page) => page.errors.map((item) => ({ page: page.label, error: item })));
  const required = [
    "realCliInitialSessionCreated", "realCliOnboardingPreseeded", "realCliOnboardingSkipped",
    "realCliEmbeddedResumeStarted", "realCliEmbeddedContextRestored",
    "realCliEmbeddedMirrorUpdated", "realCliEmbeddedExitRestored", "realCliSystemResumeStarted",
    "realCliCtrlCInterruptedRequest", "realCliHistoryExportScrollback", "realCliWheelScrollsExportedHistory",
    "terminalToolbarVisible", "realCliSystemContextRestored", "realCliSystemMirrorUpdated", "realCliSystemExitRestored",
    "realCliBridgeShutdownClean",
  ];
  if (portable) {
    evidence.portableSingleFileOnly = fs.readdirSync(appDir).length === 1
      && fs.readdirSync(appDir)[0] === "CopilotCC.exe";
    required.push("portableSingleFileOnly", "portableRuntimeIdentity", "portableGracefulShutdown");
  }
  for (const name of required) assert(evidence[name] === true, `真实 CLI 验收失败: ${name}`);
  assert(evidence.runtimeErrors.length === 0, "真实 CLI 验收存在 Chrome 运行错误");
  evidence.ok = true;
}

try {
  if (realCliResumeOnly) await runRealCliResume();
  else await run();
} catch (error) {
  evidence.ok = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  if (setupPage) {
    try {
      evidence.observations.failureSetup = await evaluate(setupPage, `(async () => {
        const stored = await chrome.storage.local.get('ccc.settings');
        const settings = stored['ccc.settings'];
        return {
          readyState: document.readyState,
          connection: document.querySelector('.conn')?.textContent || '',
          body: document.body?.innerText?.slice(0, 1200) || '',
          hasSettings: Boolean(settings), host: settings?.host || null, port: settings?.port || null,
        };
      })()`);
      await screenshot(setupPage, "setup-failure.png");
    } catch {}
  }
  if (terminalPage) {
    try {
      evidence.observations.failureTerminal = await evaluate(terminalPage, `(() => ({
        phase: document.querySelector('.terminal-phase')?.textContent || '',
        text: document.querySelector('.xterm-rows')?.textContent || '',
        activeElement: document.activeElement?.className || document.activeElement?.tagName || '',
        helperValue: document.querySelector('.xterm-helper-textarea')?.value || '',
      }))()`);
      await screenshot(terminalPage, "embedded-failure.png");
    } catch {}
  }
  if (proxy) evidence.observations.proxyTail = proxy.events.slice(-120);
  evidence.runtimeErrors = pages.flatMap((page) => page.errors.map((item) => ({ page: page.label, error: item })));
  saveEvidence();
  console.error(`EMBEDDED_TERMINAL_VERIFICATION_ERROR=${evidence.error}`);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  try { await closeTerminalTarget(); } catch (error) { cleanupErrors.push(`terminal target: ${error.message}`); }
  for (const handle of [...terminalWindows]) {
    try { await closeTracked(handle); } catch (error) { cleanupErrors.push(`terminal window: ${error.message}`); }
  }
  if (browserCdp) { try { await browserCdp.send("Browser.close"); } catch {} }
  await delay(500);
  if (chromeChild && chromeChild.exitCode === null && chromeChild.signalCode === null) chromeChild.kill();
  for (const child of externalChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  try { await stopBridge(); } catch (error) { cleanupErrors.push(`bridge: ${error.message}`); }
  for (const child of bridgeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (control) control.close();
  if (proxy) { try { await proxy.close(); } catch {} }
  await closeRealCliInterruptProxy();
  if (realUpstream) await new Promise((resolve) => realUpstream.server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  await delay(500);

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
  for (const child of [...bridgeChildren, ...externalChildren]) {
    if (child.exitCode === null && child.signalCode === null) remaining.push({ pid: child.pid, role: "direct-child" });
  }
  if (chromeChild && chromeChild.exitCode === null && chromeChild.signalCode === null) {
    remaining.push({ pid: chromeChild.pid, role: "chrome" });
  }
  const visible = listWindows();
  for (const handle of terminalWindows) {
    if (visible.some((item) => item.handle === String(handle))) remaining.push({ handle: String(handle), role: "terminal-window" });
  }
  if (chromeChild?.pid && visible.some((item) => item.pid === chromeChild.pid)) {
    remaining.push({ pid: chromeChild.pid, role: "chrome-window" });
  }
  evidence.observations.cleanup = { remaining, errors: cleanupErrors };
  if (remaining.length || cleanupErrors.length) {
    evidence.ok = false;
    process.exitCode = 1;
    evidence.error = `${evidence.error ? `${evidence.error}; ` : ""}定向清理复核失败`;
  }
  saveEvidence();
  if (evidence.ok) console.log(`EMBEDDED_TERMINAL_VERIFICATION_OK=${resultFile}`);
}
