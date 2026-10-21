/**
 * 用 bun build --compile 出单文件托盘桥：Windows x64 + macOS arm64。
 * 产物布局：dist/<平台目录>/ccc-bridge[.exe] + traybin/<平台托盘二进制>。
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

/** 构建目标。--windows-hide-console 让 win 版双击不弹黑窗；--windows-icon 内嵌 exe 图标；darwin 目标可跨平台交叉编译 */
const allTargets = [
  { key: "win", target: "bun-windows-x64", dir: "ccc-bridge-win-x64", exe: "ccc-bridge.exe", trayBin: "tray_windows_release.exe", extra: ["--windows-hide-console", `--windows-icon "${iconPath}"`] },
  { key: "darwin", target: "bun-darwin-arm64", dir: "ccc-bridge-darwin-arm64", exe: "ccc-bridge", trayBin: "tray_darwin_release", extra: [] },
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
  fs.mkdirSync(path.join(outDir, "traybin"), { recursive: true });
  // npm 全局 bun 在 Windows 上是 bun.cmd shim，execFile 不能直跑 → 走 shell
  const cmd = `bun build src/tray.ts --compile --target=${t.target} ${t.extra.join(" ")} --outfile "${path.join(outDir, t.exe)}"`;
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`✘ ${t.dir} 构建失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
  fs.copyFileSync(path.join(root, "node_modules", "systray2", "traybin", t.trayBin), path.join(outDir, "traybin", t.trayBin));
  console.log(`✔ dist/${t.dir}`);
}

console.log("");
console.log("完成。macOS 部署：");
console.log("  chmod +x ccc-bridge traybin/tray_darwin_release");
console.log("  codesign --force -s - ccc-bridge && codesign --force -s - traybin/tray_darwin_release");
console.log("  xattr -dr com.apple.quarantine . 2>/dev/null || true");
