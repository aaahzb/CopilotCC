/**
 * 生成 macOS .iconset 目录（CopilotCC Bridge.app 的图标素材）：复用桥形图标形状库
 * （悬索桥变体 c，与托盘/exe/扩展同一视觉身份；gen-icon.mjs 被 import 时不跑主流程，无副作用）。
 * 用法：node scripts/gen-iconset.mjs <输出iconset目录>
 * 后续：iconutil -c icns <目录> -o icon.icns（仅 macOS；build-mac-app.sh 已串好这一步）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { render, encodePng, VARIANTS } from "./gen-icon.mjs";

const outDir = process.argv[2];
if (!outDir) {
  console.error("用法：node scripts/gen-iconset.mjs <输出iconset目录>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// iconset 命名约定：icon_<点数>x<点数>.png 放 1x 像素图，icon_<点数>x<点数>@2x.png 放 2 倍像素图
const entries = [
  ["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64],
  ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512],
  ["512x512", 512], ["512x512@2x", 1024],
];
for (const [name, px] of entries) {
  fs.writeFileSync(path.join(outDir, `icon_${name}.png`), encodePng(render(VARIANTS.c, px), px));
}
console.log(`iconset → ${outDir}（${entries.length} 张 PNG，悬索桥变体 c）`);
