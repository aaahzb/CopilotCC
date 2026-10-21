// 把 shared/ 下的共享文件复制到 bridge 与 extension，保证两端实现一致
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const file of ["protocol.ts", "pairing.ts", "upload-note.ts"]) {
  const src = path.join(root, "shared", file);
  for (const dest of [`bridge/src/${file}`, `extension/src/lib/${file}`]) {
    const d = path.join(root, dest);
    mkdirSync(path.dirname(d), { recursive: true });
    copyFileSync(src, d);
    console.log(`已同步 → ${dest}`);
  }
}
