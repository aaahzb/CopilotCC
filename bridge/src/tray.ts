/** 托盘入口：WS 桥 + 系统托盘图标（右键菜单：复制配对串 / 修改端口 / 退出）。跨平台：win32 / darwin(arm64) / linux。 */
import systray2 from "systray2";
import type { MenuItem } from "systray2";

/** systray2 类构造器类型（取自其 d.ts 的默认导出） */
type SysTrayCtor = typeof import("systray2").default;
// CJS 互操作各运行时行为不同：tsx/esbuild 会把 default 解到类本身；bun --compile 下 default 是整个 exports（类在 .default.default）。两层兜底取构造器
const SysTray: SysTrayCtor = (() => {
  const a = systray2 as unknown as { default?: unknown };
  const b = (a.default ?? a) as { default?: unknown };
  return (b.default ?? b) as SysTrayCtor;
})();
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadOrCreateConfig, configDir } from "./config";
import { startServer } from "./server";
import { claimInstance, writeRuntime, releaseRuntimeOnExit } from "./runtime";
import { encodePairing } from "./pairing";
import { SessionManager } from "./session-manager";
import { ICON_ICO_B64, ICON_PNG_B64 } from "./icon";

/** systray2 的 MenuItem 没有 click 字段（那是它的自定义扩展属性），本地扩一个 */
type TrayItem = MenuItem & { click?: () => void };

/**
 * systray2 只认 CWD 下 ./traybin/<平台二进制>：chdir 到包含 traybin 的目录。
 * 编译分发形态 = exe 旁的 traybin/；开发形态 = node_modules/systray2/（内含 traybin/）。
 * @throws 所有候选都找不到时抛错
 */
function chdirToTraybinParent(): void {
  const exe =
    process.platform === "win32" ? "tray_windows_release.exe" : process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
  let here = "";
  try {
    here = path.dirname(fileURLToPath(import.meta.url)); // bun 编译态是虚拟路径，fileURLToPath 会抛，跳过即可
  } catch {
    // 编译态没有开发候选
  }
  const candidates = [
    path.dirname(process.execPath), // 编译分发：exe 旁
    process.cwd(), // 已在正确 CWD
    ...(here ? [path.join(here, "..", "node_modules", "systray2")] : []), // 开发：包目录
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "traybin", exe))) {
      process.chdir(dir);
      return;
    }
  }
  throw new Error(`找不到托盘二进制 traybin/${exe}，请把它放到可执行文件旁的 traybin/ 目录`);
}

/**
 * 把内嵌图标写到临时文件（systray2 只收文件路径）。
 * @returns 当前平台对应的图标文件路径（win32=ico，其他=png）
 */
function writeIcon(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-tray-"));
  const isWin = process.platform === "win32";
  const p = path.join(dir, isWin ? "icon.ico" : "icon.png");
  fs.writeFileSync(p, Buffer.from(isWin ? ICON_ICO_B64 : ICON_PNG_B64, "base64"));
  return p;
}

/** 复制文本到系统剪贴板：win32=clip，darwin=pbcopy，linux=xclip。不可用就静默 */
function copyToClipboard(text: string): void {
  const cmd = process.platform === "win32" ? "clip" : process.platform === "darwin" ? "pbcopy" : "xclip";
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
  try {
    // clip 是控制台程序；GUI 形态的托盘 exe 不给它窗口，避免复制时闪黑框
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    p.on("error", () => {});
    p.stdin.end(text);
  } catch {
    // 剪贴板工具缺失就静默
  }
}

/** 命令执行结果：ok=正常退出（text 为 trim 后输出）；exit=非零退出（如弹窗点取消）；error=进程未能启动（工具缺失） */
type CmdResult = { kind: "ok"; text: string } | { kind: "exit" } | { kind: "error" };

/**
 * 运行系统命令并收集 stdout（utf8）。
 * @param cmd 命令
 * @param args 参数
 * @returns 执行结果
 */
function runCmdCapture(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      p.on("error", () => resolve({ kind: "error" }));
      p.stdout.on("data", (d: Buffer) => (out += d.toString("utf-8")));
      p.on("close", (code) => resolve(code === 0 ? { kind: "ok", text: out.trim() } : { kind: "exit" }));
    } catch {
      resolve({ kind: "error" });
    }
  });
}

/** PowerShell 单引号字符串转义（单引号双写） */
function psQ(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** PowerShell -EncodedCommand 参数（UTF-16LE base64）：避免 -Command 直传中文被控制台代码页搅乱 */
function psEncoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** AppleScript 双引号字符串转义；字面量不能跨行，换行用 & return & 拼接 */
function asQ(s: string): string {
  const esc = (x: string): string => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return s.split("\n").map(esc).join(" & return & ");
}

/** 弹窗输入结果：input=用户确认；cancel=取消；unavailable=系统没有可用弹窗工具（调用方回退网页设置页） */
type PromptResult = { kind: "input"; text: string } | { kind: "cancel" } | { kind: "unavailable" };

/**
 * 弹系统原生输入框：win32=PowerShell VisualBasic InputBox，darwin=AppleScript display dialog，linux=zenity/kdialog。
 * @param title 窗口标题
 * @param prompt 提示语
 * @param def 默认值（预填）
 * @returns 输入结果
 */
async function promptText(title: string, prompt: string, def: string): Promise<PromptResult> {
  const tries: Array<[string, string[]]> =
    process.platform === "win32"
      ? [
          [
            "powershell",
            [
              "-NoProfile",
              "-WindowStyle",
              "Hidden",
              "-EncodedCommand",
              psEncoded(
                `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName Microsoft.VisualBasic; ` +
                  `[Microsoft.VisualBasic.Interaction]::InputBox(${psQ(prompt)}, ${psQ(title)}, ${psQ(def)})`,
              ),
            ],
          ],
        ]
      : process.platform === "darwin"
        ? [["osascript", ["-e", `text returned of (display dialog ${asQ(prompt)} default answer ${asQ(def)} with title ${asQ(title)})`]]]
        : [
            ["zenity", ["--entry", `--title=${title}`, `--text=${prompt}`, `--entry-text=${def}`]],
            ["kdialog", ["--inputbox", prompt, def]],
          ];
  for (const [cmd, args] of tries) {
    const r = await runCmdCapture(cmd, args);
    if (r.kind === "error") continue; // 工具不存在，试下一个
    if (r.kind === "exit" || r.text === "") return { kind: "cancel" }; // 非零退出或空输入都视为取消
    return { kind: "input", text: r.text };
  }
  return { kind: "unavailable" };
}

/** 弹系统原生消息框（结果/错误提示）。没有可用弹窗工具就静默 */
function showMessage(title: string, text: string): void {
  const tries: Array<[string, string[]]> =
    process.platform === "win32"
      ? [
          [
            "powershell",
            [
              "-NoProfile",
              "-WindowStyle",
              "Hidden",
              "-EncodedCommand",
              psEncoded(`Add-Type -AssemblyName Microsoft.VisualBasic; [void][Microsoft.VisualBasic.Interaction]::MsgBox(${psQ(text)}, 0, ${psQ(title)})`),
            ],
          ],
        ]
      : process.platform === "darwin"
        ? [["osascript", ["-e", `display dialog ${asQ(text)} with title ${asQ(title)} buttons {"OK"} default button "OK"`]]]
        : [
            ["zenity", ["--info", `--title=${title}`, `--text=${text}`]],
            ["kdialog", ["--title", title, "--msgbox", text]],
          ];
  const tryNext = (i: number): void => {
    const t = tries[i];
    if (!t) return;
    try {
      const p = spawn(t[0], t[1], { stdio: "ignore", windowsHide: true });
      p.on("error", () => tryNext(i + 1)); // 工具缺失就换下一个
    } catch {
      tryNext(i + 1);
    }
  };
  tryNext(0);
}

/** 用系统默认浏览器打开 URL：win32=cmd start（第一个引号参数是窗口标题，必须给空串），darwin=open，linux=xdg-open。失败静默 */
function openUrl(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    // 托盘 exe 是 GUI 程序：不给子进程窗口，避免闪黑框
    const p = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    p.on("error", () => {});
  } catch {
    // 没有可用的浏览器入口就静默
  }
}

/** 托盘主流程：读配置 → 起 WS 桥（含 /config 设置页）→ 定位托盘二进制 → 建托盘菜单 */
async function main(): Promise<void> {
  const config = loadOrCreateConfig();
  claimInstance(configDir()); // 单实例守卫：已有活实例直接抛错（落 tray-error.log）
  const sessions = new SessionManager(path.join(configDir(), "sessions.json"));
  sessions.load();

  // 在线改端口的回调在 startServer 之前就注册，但触发一定在托盘建好之后（用户从托盘菜单进设置页）；
  // 回调里复用同一份 items 对象（systray2 按 init 时分配的 __id 映射点击，对象不换引用就不会失配）
  let systray: InstanceType<SysTrayCtor> | null = null;
  let items: TrayItem[] = [];
  let icon = "";

  /** 端口在线切换后：写 runtime.json，并推 update-menu 刷新托盘状态行与 tooltip */
  const onPortChanged = (p: number): void => {
    writeRuntime(configDir(), p);
    const status = items[0];
    if (!systray || !status) return;
    status.title = `Claude Code 桥接运行中（端口 ${p}）`;
    void systray.sendAction({
      type: "update-menu",
      menu: { icon, title: "", tooltip: `Claude Code 桥接 · 端口 ${p}`, items, isTemplateIcon: false },
    });
  };

  const server = await startServer({ config, sessions, configDir: configDir(), onPortChanged });
  writeRuntime(configDir(), server.port);
  releaseRuntimeOnExit(configDir());
  console.log(`[ccc-bridge] 已启动 ws://127.0.0.1:${server.port}/ws（托盘模式）`);

  /**
   * 「修改端口…」完整流程：弹系统输入框 → 校验 → 在线切换（setPort 内含持久化与菜单刷新回调）
   * → 新配对串复制到剪贴板并弹结果提示。系统弹窗不可用（如精简 Linux）时回退内置网页设置页。
   */
  const changePortFlow = async (): Promise<void> => {
    const r = await promptText("Claude Code 桥接 · 修改端口", `当前端口 ${server.port}。输入新端口（1024-65535）：`, String(server.port));
    if (r.kind === "unavailable") {
      openUrl(`http://127.0.0.1:${server.port}/config?t=${config.token}`);
      return;
    }
    if (r.kind === "cancel") return;
    const p = Number(r.text);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      showMessage("Claude Code 桥接 · 修改端口", "端口需为 1024-65535 的整数");
      return;
    }
    try {
      const port = await server.setPort(p);
      copyToClipboard(encodePairing({ h: "127.0.0.1", p: port, t: config.token })); // 顺手复制：用户下一步就是去扩展粘贴
      showMessage("Claude Code 桥接 · 修改端口", `已切换到端口 ${port}。\n新配对串已复制到剪贴板，到扩展侧栏点「⚙ 配对」粘贴一次即可。`);
    } catch (e) {
      showMessage("Claude Code 桥接 · 修改端口失败", e instanceof Error ? e.message : String(e));
    }
  };

  chdirToTraybinParent();
  icon = writeIcon();
  // server.port 是 getter，在线改端口后始终返回当前值：配对串与设置页 URL 无需额外跟踪端口
  items = [
    { title: `Claude Code 桥接运行中（端口 ${server.port}）`, tooltip: "", enabled: false },
    {
      title: "复制配对串",
      tooltip: "地址+端口+Token 打包成一串，粘贴到扩展配对框",
      enabled: true,
      click: () => copyToClipboard(encodePairing({ h: "127.0.0.1", p: server.port, t: config.token })),
    },
    {
      title: "修改端口…",
      tooltip: "弹窗输入新端口，保存即生效；新配对串自动复制，到扩展「⚙ 配对」粘贴一次",
      enabled: true,
      click: () => void changePortFlow(),
    },
    SysTray.separator,
    {
      title: "退出",
      tooltip: "",
      enabled: true,
      click: () => {
        void systray?.kill(false).then(() => process.exit(0));
      },
    },
  ];
  systray = new SysTray({
    menu: {
      icon,
      isTemplateIcon: false, // 彩色图标，不做 macOS 模板剪影
      title: "",
      tooltip: `Claude Code 桥接 · 端口 ${server.port}`,
      items,
    },
    debug: false,
    copyDir: false,
  });
  systray.onClick((a) => {
    (a.item as TrayItem).click?.();
  });
  await systray.ready();
  console.log("[ccc-bridge] 托盘图标已就绪");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  console.error("[ccc-bridge] 托盘启动失败:", msg);
  try {
    // --windows-hide-console 编译版没有控制台，错误同时落一份日志便于排查
    fs.mkdirSync(configDir(), { recursive: true });
    fs.appendFileSync(path.join(configDir(), "tray-error.log"), `${new Date().toISOString()} ${msg}\n`, "utf-8");
  } catch {
    // 日志写不了就算了
  }
  process.exit(1);
});
