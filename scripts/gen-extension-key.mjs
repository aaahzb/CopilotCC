// 生成扩展固定 key（manifest.key）与其对应的扩展 ID。
// 固定 key → 固定扩展 ID → 桥接服务可以配置 Origin 白名单。只需跑一次，输出人工粘贴。
import { generateKeyPairSync, createHash } from "node:crypto";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ format: "der", type: "spki" });
const digest = createHash("sha256").update(der).digest();
// 扩展 ID 算法：SHA256 前 16 字节，每个半字节映射到 a-p
const id = [...digest.subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join("");

console.log("manifest.key（粘贴进 wxt.config.ts）:\n" + der.toString("base64"));
console.log("\n扩展 ID:\n" + id);
console.log("\n桥接 allowedOrigins 配置值:\nchrome-extension://" + id);
