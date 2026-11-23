// 把 shared/ 下的共享文件复制到 bridge 与 extension，保证两端实现一致
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("用法: node scripts/sync-protocol.mjs [--check]\n\n默认同步副本；--check 只检查漂移，不写文件。");
  process.exit(0);
}
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0) {
  console.error(`未知参数: ${unknown.join(", ")}\n用法: node scripts/sync-protocol.mjs [--check]`);
  process.exit(2);
}
const check = args.includes("--check");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mismatches = [];

for (const file of ["protocol.ts", "pairing.ts", "upload-note.ts"]) {
  const src = path.join(root, "shared", file);
  for (const dest of [`bridge/src/${file}`, `extension/src/lib/${file}`]) {
    const d = path.join(root, dest);
    if (check) {
      let current;
      try {
        current = readFileSync(d);
      } catch {
        current = null;
      }
      if (current === null || !current.equals(readFileSync(src))) {
        mismatches.push(dest);
        console.error(`副本不一致 → ${dest}`);
      }
    } else {
      mkdirSync(path.dirname(d), { recursive: true });
      copyFileSync(src, d);
      console.log(`已同步 → ${dest}`);
    }
  }
}

if (mismatches.length > 0) {
  console.error(`发现 ${mismatches.length} 个漂移副本，请运行 node scripts/sync-protocol.mjs`);
  process.exitCode = 1;
} else if (check) {
  console.log("共享文件副本一致");
}
