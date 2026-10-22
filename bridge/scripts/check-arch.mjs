/**
 * 预编译二进制架构断言（CI 用）：读文件头几个字节判定 CPU 架构，与期望不符即 exit 1。
 * 覆盖三种格式：PE（Windows exe，Machine 字段）/ Mach-O thin（macOS 单架构，cputype 字段）/ ELF（Linux，e_machine 字段）。
 * 背景：systray2 自带的 tray_darwin_release 是 x86_64 单架构却进了 arm64 的 mac 包（2026-10-23 实锤）——
 * 这类错误构建期不可见、运行时才炸，但架构就写在文件头里，读出来比对即可让 CI 必挂。
 * 用法：node scripts/check-arch.mjs <文件> <期望架构：x64 | x86_64 | arm64>（x64 与 x86_64 视为同义）
 * 退出码：0 匹配；1 不匹配；2 用法错误或格式不认（含 fat/universal Mach-O——多架构包请逐个 thin 断言）
 */
import * as fs from "node:fs";

const [file, expect] = process.argv.slice(2);
if (!file || !expect || !["x64", "x86_64", "arm64"].includes(expect)) {
  console.error("用法：node scripts/check-arch.mjs <文件> <x64|x86_64|arm64>");
  process.exit(2);
}

/**
 * 从文件头判定 CPU 架构。
 * @param file 文件路径
 * @returns 识别出的架构（"x64" | "x86_64" | "arm64" | "x86"），或特殊值（"fat" / "未知格式" / 带十六进制的未知描述）
 */
function detectArch(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    // PE（Windows）："MZ" 魔数 → 0x3C 处是 PE 头偏移（e_lfanew，不固定，须按指针跳）→ "PE\0\0" 后 Machine 字段
    if (head[0] === 0x4d && head[1] === 0x5a) {
      const peOff = head.readUInt32LE(0x3c);
      const pe = Buffer.alloc(8);
      fs.readSync(fd, pe, 0, 8, peOff);
      if (pe.readUInt32LE(0) !== 0x00004550) return "未知格式"; // "PE\0\0"
      const machine = pe.readUInt16LE(4);
      return { 0x8664: "x64", 0xaa64: "arm64", 0x014c: "x86" }[machine] ?? `未知PE(0x${machine.toString(16)})`;
    }
    // fat/universal Mach-O（CAFEBABE/CAFEBABF，大端魔数）：多架构合一，本脚本不展开
    if (head.readUInt32BE(0) === 0xcafebabe || head.readUInt32BE(0) === 0xcafebabf) return "fat";
    // Mach-O thin LE 64 位（魔数 CFFAEDFE，按 LE 读是 0xFEEDFACF）：偏移 4 是 cputype
    if (head.readUInt32LE(0) === 0xfeedfacf) {
      const cpu = head.readUInt32LE(4);
      return { 0x01000007: "x86_64", 0x0100000c: "arm64" }[cpu] ?? `未知MachO(0x${cpu.toString(16)})`;
    }
    // ELF（Linux）："\x7fELF" 魔数 → 偏移 18 是 e_machine（x64/arm64 的 ELF 均为小端）
    if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
      const machine = head.readUInt16LE(18);
      return { 0x3e: "x86_64", 0xb7: "arm64" }[machine] ?? `未知ELF(0x${machine.toString(16)})`;
    }
    return "未知格式";
  } finally {
    fs.closeSync(fd);
  }
}

const actual = detectArch(file);
if (actual === "fat") {
  console.error(`✘ ${file}：fat/universal 多架构包，请对其中的 thin 二进制逐个断言`);
  process.exit(2);
}
// x64 与 x86_64 是同一架构在 PE/Mach-O/ELF 里的惯用名差异，视为同义
const same = actual === expect || (actual === "x64" && expect === "x86_64") || (actual === "x86_64" && expect === "x64");
if (!same) {
  console.error(`✘ ${file}：架构 ${actual}，期望 ${expect}`);
  process.exit(1);
}
console.log(`✔ ${file}：架构 ${actual}（期望 ${expect}）`);
