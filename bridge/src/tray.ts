/** 托盘入口：WS 桥 + 系统托盘图标（右键菜单：复制 token / 退出）。跨平台：win32 / darwin(arm64) / linux。 */
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
import { SessionManager } from "./session-manager";
import { ICON_ICO_B64, ICON_PNG_B64 } from "./icon";

/** systray2 的 MenuItem 没有 click 字段（那是它的自定义扩展属性），本地扩一个 */
type TrayItem = MenuItem & { click?: () => void };

/**
 * systray2 只认 CWD 下的 ./traybin/<平台二进制>：chdir 到包含 traybin 的目录。
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

/** 托盘主流程：读配置 → 起 WS 桥 → 定位托盘二进制 → 建托盘菜单 */
async function main(): Promise<void> {
  const config = loadOrCreateConfig();
  const sessions = new SessionManager(path.join(configDir(), "sessions.json"));
  sessions.load();
  startServer({ config, sessions });
  console.log(`[ccc-bridge] 已启动 ws://127.0.0.1:${config.port}/ws（托盘模式）`);

  chdirToTraybinParent();
  const icon = writeIcon();
  const items: TrayItem[] = [
    { title: `Claude Code 桥接运行中（端口 ${config.port}）`, tooltip: "", enabled: false },
    { title: "复制配对 Token", tooltip: "复制到剪贴板，粘贴到扩展设置页", enabled: true, click: () => copyToClipboard(config.token) },
    SysTray.separator,
    {
      title: "退出",
      tooltip: "",
      enabled: true,
      click: () => {
        void systray.kill(false).then(() => process.exit(0));
      },
    },
  ];
  const systray = new SysTray({
    menu: {
      icon,
      isTemplateIcon: false, // 彩色图标，不做 macOS 模板剪影
      title: "",
      tooltip: `Claude Code 桥接 · 端口 ${config.port}`,
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
