/**
 * 生成扩展图标：复用桥接图标形状库（悬索桥变体 c，与托盘/exe 同一视觉身份）。
 * 输出 extension/public/icon/{16,32,48,128}.png（PNG 全平台 Chrome 通用）。
 * 用法：node scripts/gen-ext-icon.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { render, encodePng, VARIANTS } from "../bridge/scripts/gen-icon.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "extension", "public", "icon");
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  const png = encodePng(render(VARIANTS.c, s), s);
  fs.writeFileSync(path.join(outDir, `${s}.png`), png);
  console.log(`icon/${s}.png ${png.length}B`);
}
console.log("完成：extension/public/icon/（悬索桥变体 c，与托盘同源）");
