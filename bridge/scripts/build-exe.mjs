/**
 * 用 bun build --compile 出托盘桥：Windows x64 + macOS arm64。
 * 产物布局：win = dist/ccc-bridge-win-x64/{ccc-bridge.exe,ccc-terminal.exe,pty/,pty-manifest.json}
 *           （GUI 托盘 + Console 终端包装 + 经实探选择的完整 PTY 原生运行时；
 *           托盘组件 base64 内嵌进主程序，首跑释放到 ~/.ccc-bridge/traybin/）；
 *           darwin = dist/ccc-bridge-darwin-arm64/ccc-bridge（托盘助手由 build-mac-app.sh 现场编译 bridge/tray/main.swift 产出——
 *           systray2 自带的 tray_darwin_release 是 x86_64 单架构，无 Rosetta 的 Apple Silicon 起不来，已弃用）。
 * 运行：先执行 scripts/run-pty-probe.mjs，再运行 node scripts/build-exe.mjs win --pty-route /abs/pty-route.json。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { packagePty, readSuccessfulPtyRoute } from "./package-pty.mjs";
import { verifyNativeLayout } from "./verify-native-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
/** exe 图标（scripts/gen-icon.mjs 生成的多尺寸 ICO；已入库，缺失时报错提示重生） */
const iconPath = path.join(root, "assets", "icon.ico");
if (!fs.existsSync(iconPath)) {
  console.error("缺少 assets/icon.ico，请先运行 node scripts/gen-icon.mjs");
  process.exit(1);
}

/**
 * win 内嵌托盘组件的 TS 模块：编译前临时写入真实 base64，编完还原占位（成功失败都还原，保证工作区干净）。
 * 占位内容与 src/traybin-win-b64.ts 的入库版本必须逐字一致，改占位要两边同步。
 */
const traybinB64Path = path.join(root, "src", "traybin-win-b64.ts");
const TRAYBIN_B64_PLACEHOLDER = `/**
 * win 单文件分发的内嵌托盘组件：systray2 的 tray_windows_release.exe 的 base64。
 * 本文件是占位（空串 = 未内嵌，开发态走 node_modules 查找）；node scripts/build-exe.mjs 编译 win 版前
 * 会把它临时覆盖为真实内容，编完即还原——仓库里永远只存占位。
 */
export const TRAYBIN_WIN_B64 = "";
`;

/** 构建目标。--windows-hide-console 让 win 版双击不弹黑窗；--windows-icon 内嵌 exe 图标；darwin 目标可跨平台交叉编译 */
const allTargets = [
  // win：GUI 托盘 + Console 终端包装双 exe；托盘组件内嵌进主程序、首跑释放到配置目录
  { key: "win", target: "bun-windows-x64", dir: "ccc-bridge-win-x64", exe: "ccc-bridge.exe", trayBin: "tray_windows_release.exe", embed: true, extra: ["--windows-hide-console", `--windows-icon "${iconPath}"`] },
  // darwin：不再带 systray2 的 x86_64 托盘组件；arm64 托盘助手由 build-mac-app.sh 现场编译进 .app
  { key: "darwin", target: "bun-darwin-arm64", dir: "ccc-bridge-darwin-arm64", exe: "ccc-bridge", trayBin: null, embed: false, extra: [] },
];

// 平台过滤：node scripts/build-exe.mjs [win|darwin] [--pty-route /abs/pty-route.json]
// 发行包必须绑定同平台、六项行为全过的真实探针报告；没有报告时不删除旧产物、不猜默认路线。
const args = process.argv.slice(2);
const only = args[0];
if (only && !allTargets.some((t) => t.key === only)) {
  console.error(`未知平台 ${only}，可选：${allTargets.map((t) => t.key).join("/")}（缺省全部）`);
  process.exit(1);
}
let cliRouteReport = "";
if (args.length > 1) {
  if (args.length !== 3 || args[1] !== "--pty-route" || !path.isAbsolute(args[2] ?? "")) {
    console.error("用法：node scripts/build-exe.mjs [win|darwin] [--pty-route <绝对 pty-route.json>]");
    process.exit(1);
  }
  cliRouteReport = args[2];
}
const targets = only ? allTargets.filter((t) => t.key === only) : allTargets;
if (targets.length !== 1 && cliRouteReport) {
  console.error("同时构建两个平台时请分别使用 CCC_PTY_ROUTE_WIN / CCC_PTY_ROUTE_DARWIN");
  process.exit(1);
}
const routeByTarget = new Map();
for (const target of targets) {
  const envKey = `CCC_PTY_ROUTE_${target.key.toUpperCase()}`;
  const report = cliRouteReport || process.env[envKey] || (targets.length === 1 ? process.env.CCC_PTY_ROUTE_REPORT : "");
  if (!report || !path.isAbsolute(report)) {
    console.error(`${target.key} 缺少成功 PTY 探针报告；请先运行 run-pty-probe.mjs，再用 --pty-route 指定绝对路径`);
    process.exit(1);
  }
  try {
    routeByTarget.set(target.key, readSuccessfulPtyRoute(report, target.key));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

for (const t of targets) {
  const outDir = path.join(dist, t.dir);
  fs.rmSync(outDir, { recursive: true, force: true }); // 清掉本平台旧产物（构建输出，可随时重建）
  fs.mkdirSync(outDir, { recursive: true });
  if (t.embed) {
    // 单文件分发：托盘组件 base64 临时写进 TS 模块参与编译
    const b64 = fs.readFileSync(path.join(root, "node_modules", "systray2", "traybin", t.trayBin)).toString("base64");
    fs.writeFileSync(traybinB64Path, `export const TRAYBIN_WIN_B64 = "${b64}";\n`);
  } else if (t.trayBin) {
    fs.mkdirSync(path.join(outDir, "traybin"), { recursive: true });
  }
  // npm 全局 bun 在 Windows 上是 bun.cmd shim，execFile 不能直跑 → 走 shell
  const cmd = `bun build src/tray.ts --compile --target=${t.target} ${t.extra.join(" ")} --outfile "${path.join(outDir, t.exe)}"`;
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (t.embed) fs.writeFileSync(traybinB64Path, TRAYBIN_B64_PLACEHOLDER); // 成功失败都还原占位
  if (r.status !== 0) {
    console.error(`✘ ${t.dir} 构建失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
  // Windows 交互终端不能复用 GUI 托盘 exe；同目录另编 Console 包装，不携带 --windows-hide-console。
  if (t.key === "win") {
    const terminalCmd = `bun build src/index.ts --compile --target=${t.target} --outfile "${path.join(outDir, "ccc-terminal.exe")}"`;
    const terminalResult = spawnSync(terminalCmd, { cwd: root, stdio: "inherit", shell: true });
    if (terminalResult.status !== 0) {
      console.error(`✘ ${t.dir} Console 终端包装构建失败（exit ${terminalResult.status}）`);
      process.exit(terminalResult.status ?? 1);
    }
  }
  if (!t.embed && t.trayBin) {
    fs.copyFileSync(path.join(root, "node_modules", "systray2", "traybin", t.trayBin), path.join(outDir, "traybin", t.trayBin));
  }
  const backend = routeByTarget.get(t.key);
  await packagePty({
    target: t.key,
    backend,
    outDir,
    nodeRuntime: backend === "node-helper" ? (process.env.CCC_PTY_NODE22 || process.execPath) : null,
  });
  await verifyNativeLayout(outDir, t.key === "win" ? "win32" : "darwin", t.key === "win" ? "x64" : "arm64");
  console.log(`✔ dist/${t.dir}（PTY ${backend}，原生布局与 SHA-256 已校验）`);
}

console.log("");
console.log("完成。macOS 打包下一步（仅 macOS）：bash scripts/build-mac-app.sh  # 组装 .app + ad-hoc 预签 + dmg");
