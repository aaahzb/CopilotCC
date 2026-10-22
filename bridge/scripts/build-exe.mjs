/**
 * 用 bun build --compile 出托盘桥：Windows x64 + macOS arm64。
 * 产物布局：win = dist/ccc-bridge-win-x64/ccc-bridge.exe 单文件（托盘组件 base64 内嵌，首跑释放到 ~/.ccc-bridge/traybin/）；
 *           darwin = dist/ccc-bridge-darwin-arm64/ccc-bridge + traybin/tray_darwin_release（setup.command 要对它签名）。
 * 运行：node scripts/build-exe.mjs（需要全局 bun，npm i -g bun）。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  // win：单文件分发（embed=true），托盘组件内嵌进 exe、首跑释放到配置目录，zip 里只有一个 exe
  { key: "win", target: "bun-windows-x64", dir: "ccc-bridge-win-x64", exe: "ccc-bridge.exe", trayBin: "tray_windows_release.exe", embed: true, extra: ["--windows-hide-console", `--windows-icon "${iconPath}"`] },
  // darwin：托盘组件走 exe 旁 traybin/（setup.command 要对它 ad-hoc 签名，须是磁盘上的真实文件）
  { key: "darwin", target: "bun-darwin-arm64", dir: "ccc-bridge-darwin-arm64", exe: "ccc-bridge", trayBin: "tray_darwin_release", embed: false, extra: [] },
];

// 平台过滤：node scripts/build-exe.mjs [win|darwin]，缺省全部（release CI 在 mac runner 上只编 darwin）
const only = process.argv[2];
if (only && !allTargets.some((t) => t.key === only)) {
  console.error(`未知平台 ${only}，可选：${allTargets.map((t) => t.key).join("/")}（缺省全部）`);
  process.exit(1);
}
const targets = only ? allTargets.filter((t) => t.key === only) : allTargets;

for (const t of targets) {
  const outDir = path.join(dist, t.dir);
  fs.rmSync(outDir, { recursive: true, force: true }); // 清掉本平台旧产物（构建输出，可随时重建）
  fs.mkdirSync(outDir, { recursive: true });
  if (t.embed) {
    // 单文件分发：托盘组件 base64 临时写进 TS 模块参与编译
    const b64 = fs.readFileSync(path.join(root, "node_modules", "systray2", "traybin", t.trayBin)).toString("base64");
    fs.writeFileSync(traybinB64Path, `export const TRAYBIN_WIN_B64 = "${b64}";\n`);
  } else {
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
  if (!t.embed) {
    fs.copyFileSync(path.join(root, "node_modules", "systray2", "traybin", t.trayBin), path.join(outDir, "traybin", t.trayBin));
  }
  console.log(`✔ dist/${t.dir}`);
}

console.log("");
console.log("完成。macOS 打包下一步（仅 macOS）：bash scripts/build-mac-app.sh  # 组装 .app + ad-hoc 预签 + dmg");
