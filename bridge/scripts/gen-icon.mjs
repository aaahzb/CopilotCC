/**
 * 生成桥形图标：
 *  - src/icon.ts（托盘用，勿手改）：64x64 PNG（darwin/linux）+ 多尺寸 ICO（win32）
 *  - assets/icon.ico（exe 图标用）：16/32/48/256 多尺寸，PNG 压缩内嵌（Vista+ 支持）
 *  - 预览条写到 %TEMP%/ccc-icon-preview.png（3 变体 × 96/32/16 三档 × 浅/深底）
 * 用法：node scripts/gen-icon.mjs [a|b|c]（默认 a；也可用环境变量 CCC_ICON_VARIANT）
 * 变体：a=拱桥（甲板+拱），b=拱桥+桥墩，c=悬索桥（双塔+垂索+甲板+吊杆）
 */
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const COLOR = [217, 119, 87]; // Claude 橙
const VARIANT = (process.argv[2] ?? process.env.CCC_ICON_VARIANT ?? "a").toLowerCase();

/* ---------------- 形状库（单位坐标系：32x32，y 向下） ---------------- */

/** 点到线段距离 */
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 圆头胶囊条（线段 + 圆头端帽） */
const capsule = (x1, y1, x2, y2, w) => (px, py) => segDist(px, py, x1, y1, x2, y2) <= w / 2;

/** 圆弧描边（cx,cy 圆心，R 半径，w 线宽，仅保留 y >= yMin 的下半部分） */
const arc = (cx, cy, R, w, yMin) => (px, py) => py >= yMin && Math.abs(Math.hypot(px - cx, py - cy) - R) <= w / 2;

/** 垂缆在 x 处的 y（抛物线：两端 y=8，中点下垂到 y=16） */
const cableY = (x) => 8 + 8 * (1 - ((x - 16) / 8) ** 2);

/** 悬索垂缆：沿抛物线采样小圆拼出 */
function cableTest() {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const x = 8 + (16 * i) / 64;
    pts.push([x, cableY(x)]);
  }
  return (px, py) => pts.some(([x, y]) => Math.hypot(px - x, py - y) <= 0.75);
}

const VARIANTS = {
  // a：拱桥——甲板 + 下半拱（拱端没入甲板下缘）
  a: [
    capsule(4, 12.5, 28, 12.5, 3),
    arc(16, 14.5, 10, 2.8, 14),
  ],
  // b：拱桥 + 两端桥墩（墩对齐拱端）
  b: [
    capsule(4, 12.5, 28, 12.5, 3),
    arc(16, 14.5, 10, 2.8, 14),
    capsule(6, 14.5, 6, 25, 2.6),
    capsule(26, 14.5, 26, 25, 2.6),
  ],
  // c：悬索桥——双塔 + 垂缆 + 甲板 + 三根吊杆
  c: [
    capsule(8, 7, 8, 23.5, 2.4),
    capsule(24, 7, 24, 23.5, 2.4),
    cableTest(),
    capsule(3, 20, 29, 20, 2.6),
    capsule(12, cableY(12), 12, 20, 1.1),
    capsule(16, cableY(16), 16, 20, 1.1),
    capsule(20, cableY(20), 20, 20, 1.1),
  ],
};

/* ---------------- 渲染：6x 超采样覆盖率 → alpha ---------------- */

const SS = 6;

/**
 * 把指定变体渲染成 NxN 的 RGBA 位图（单色 + 覆盖率 alpha）。
 * @param {Array<(x:number,y:number)=>boolean>} tests 形状测试函数数组（任一命中即覆盖）
 * @param {number} N 输出边长
 * @returns {Buffer} 长度 N*N*4
 */
function render(tests, N) {
  const buf = Buffer.alloc(N * N * 4);
  let o = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((x + (sx + 0.5) / SS) / N) * 32;
          const uy = ((y + (sy + 0.5) / SS) / N) * 32;
          if (tests.some((t) => t(ux, uy))) cov++;
        }
      }
      buf[o++] = COLOR[0];
      buf[o++] = COLOR[1];
      buf[o++] = COLOR[2];
      buf[o++] = Math.round((cov / (SS * SS)) * 255);
    }
  }
  return buf;
}

/* ---------------- PNG 编码 ---------------- */

const table = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * RGBA 位图 → PNG（8bit RGBA，扫描行 filter 0）。
 * @param {Buffer} rgba render() 的输出（或合成画布）
 * @param {number} W 宽
 * @param {number} [H] 高，缺省 = W（正方形）
 * @returns {Buffer} PNG 文件内容
 */
function encodePng(rgba, W, H = W) {
  const stride = W * 4;
  const raw = Buffer.alloc(H * (1 + stride));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- 多尺寸 ICO（PNG 内嵌，Vista+） ---------------- */

/** @param {Map<number, Buffer>} pngsBySize 尺寸 → PNG */
function encodeIco(pngsBySize) {
  const sizes = [...pngsBySize.keys()];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + sizes.length * 16;
  const entries = [];
  const blobs = [];
  for (const s of sizes) {
    const png = pngsBySize.get(s);
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; // ICO 规范：256 记 0
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------------- 主流程 ---------------- */
function main() {

const tests = VARIANTS[VARIANT];
if (!tests) {
  console.error(`未知变体 ${VARIANT}，可选：${Object.keys(VARIANTS).join("/")}`);
  process.exit(1);
}

const png64 = encodePng(render(tests, 64), 64);
const icoSizes = new Map();
for (const s of [16, 32, 48, 256]) icoSizes.set(s, encodePng(render(tests, s), s));
const ico = encodeIco(icoSizes);

const here = path.dirname(fileURLToPath(import.meta.url));
const iconTs = path.resolve(here, "..", "src", "icon.ts");
fs.writeFileSync(
  iconTs,
  "/** 托盘图标（由 scripts/gen-icon.mjs 生成，勿手改）：Claude 橙桥形。PNG(64px) 用于 darwin/linux，ICO(16/32/48/256) 用于 win32 */\n" +
    `export const ICON_PNG_B64 = ${JSON.stringify(png64.toString("base64"))};\n` +
    `export const ICON_ICO_B64 = ${JSON.stringify(ico.toString("base64"))};\n`,
  "utf-8",
);

const assetsDir = path.resolve(here, "..", "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, "icon.ico"), ico);

// 预览条：3 变体 × (96/32/16) × 浅/深底，写到临时目录供人工检查
const TILES = [96, 32, 16];
const GAP = 12;
const PW = Object.keys(VARIANTS).length * TILES.length * (96 + GAP) + GAP;
const ROW_H = 96 + 2 * GAP;
const PH = 2 * ROW_H;
const canvas = Buffer.alloc(PW * PH * 4);
for (let i = 0; i < PW * PH; i++) {
  const light = Math.floor(i / PW) < ROW_H; // 上半浅底，下半深底
  const bg = light ? 235 : 36;
  canvas[i * 4] = bg;
  canvas[i * 4 + 1] = bg;
  canvas[i * 4 + 2] = bg;
  canvas[i * 4 + 3] = 255;
}

/** 最近邻放大 scale 倍合成到画布 (ox,oy)，图标 alpha 叠到指定底色上 */
function blit(rgba, size, ox, oy, scale, bg) {
  for (let y = 0; y < size * scale; y++) {
    for (let x = 0; x < size * scale; x++) {
      const si = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
      const di = ((oy + y) * PW + (ox + x)) * 4;
      const a = rgba[si + 3] / 255;
      for (let c = 0; c < 3; c++) canvas[di + c] = Math.round(rgba[si + c] * a + bg[c] * (1 - a));
    }
  }
}

let ox = GAP;
for (const name of Object.keys(VARIANTS)) {
  for (const size of TILES) {
    const rgba = render(VARIANTS[name], size);
    const scale = 96 / size; // 统一放大到 96 高，便于比较（小尺寸同时暴露实际观感）
    blit(rgba, size, ox, GAP, scale, [235, 235, 235]);
    blit(rgba, size, ox, ROW_H + GAP, scale, [36, 36, 36]);
    ox += 96 + GAP;
  }
}
const preview = path.join(os.tmpdir(), "ccc-icon-preview.png");
fs.writeFileSync(preview, encodePng(canvas, PW, PH));

console.log(`变体 ${VARIANT} → src/icon.ts + assets/icon.ico（png64=${png64.length}B ico=${ico.length}B）`);
console.log("预览:", preview, "（a 拱桥 / b 拱桥+桥墩 / c 悬索桥；每变体 96·32·16，上浅底下深底）");

}

// 直接执行（node gen-icon.mjs）时才跑主流程；被 import 时只取形状库与编码函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { render, encodePng, encodeIco, VARIANTS };
