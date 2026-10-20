// 把 shared/protocol.ts 复制到 bridge 与 extension，保证两端协议一致
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "shared", "protocol.ts");

for (const dest of ["bridge/src/protocol.ts", "extension/src/lib/protocol.ts"]) {
  const d = path.join(root, dest);
  mkdirSync(path.dirname(d), { recursive: true });
  copyFileSync(src, d);
  console.log(`已同步 → ${dest}`);
}
