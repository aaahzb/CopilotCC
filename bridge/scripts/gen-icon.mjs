/** 生成托盘图标常量文件 src/icon.ts：32x32 橙色圆点 PNG + 同内容 ICO（PNG 压缩内嵌，Vista+ 支持）。 */
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 32;
const R = 13; // 圆半径
const CX = SIZE / 2;
const CY = SIZE / 2;
const COLOR = [217, 119, 87]; // Claude 橙

// 像素：圆内实色，圆外透明（1px 抗锯齿过渡）；PNG 扫描行每行前置 filter 字节 0
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
    const a = d <= R - 1 ? 255 : d >= R ? 0 : Math.round((R - d) * 255);
    raw[o++] = COLOR[0];
    raw[o++] = COLOR[1];
    raw[o++] = COLOR[2];
    raw[o++] = a;
  }
}

// CRC32（PNG 块校验用）
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

// ICO：ICONDIR + 1 个 ICONDIRENTRY + PNG 数据
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = SIZE;
entry[1] = SIZE;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([header, entry, png]);

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "icon.ts");
fs.writeFileSync(
  out,
  "/** 托盘图标（由 scripts/gen-icon.mjs 生成，勿手改）：32x32 橙色圆点。PNG 用于 darwin/linux，ICO 用于 win32 */\n" +
    `export const ICON_PNG_B64 = ${JSON.stringify(png.toString("base64"))};\n` +
    `export const ICON_ICO_B64 = ${JSON.stringify(ico.toString("base64"))};\n`,
  "utf-8",
);
console.log("已生成", out, "png", png.length, "B / ico", ico.length, "B");
