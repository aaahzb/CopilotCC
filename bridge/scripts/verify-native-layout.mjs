import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 递归列出普通文件并拒绝符号链接。 @param root 根目录。 @returns 绝对路径列表。 */
function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("symbolic links are not allowed");
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

/** 将路径统一为 POSIX 分隔符。 @param value 原生路径。 @returns 斜杠路径。 */
function slash(value) {
  return value.split(path.sep).join("/");
}

/** 计算 SHA-256。 @param file 文件路径。 @returns 十六进制摘要。 */
function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * 逐项校验发行 PTY 清单、必需原生文件、完整文件集合、SHA-256 和 Darwin 执行位。
 * @param {string} outDir 含 pty-manifest.json 的发行目录。
 * @param {string} [expectedPlatform] 可选目标平台；缺省读取 manifest。
 * @param {string} [expectedArch] 可选目标架构；缺省读取 manifest。
 * @param {{platform?:string,stat?:(file:string)=>{mode:number}}} [host] 可注入的校验宿主参数。
 * @returns {Promise<boolean>} 全部一致时返回 true。
 * @throws {Error} 任意缺失、额外文件、目标、摘要或必需执行位不符时抛 NATIVE_LAYOUT。
 */
export async function verifyNativeLayout(outDir, expectedPlatform, expectedArch, host = {}) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "pty-manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || !["bun-node-pty", "node-helper"].includes(manifest.backend)
      || !Array.isArray(manifest.files)) throw new Error("invalid manifest shape");
    if (expectedPlatform && manifest.platform !== expectedPlatform) throw new Error("platform mismatch");
    if (expectedArch && manifest.arch !== expectedArch) throw new Error("architecture mismatch");
    const prebuild = `${manifest.platform}-${manifest.arch}`;
    if (!["win32-x64", "darwin-arm64"].includes(prebuild)) throw new Error("unsupported target");
    const required = [
      "pty/node_modules/node-pty/package.json",
      "pty/node_modules/node-pty/lib/index.js",
      "pty/node_modules/node-addon-api/package.json",
      `pty/node_modules/node-pty/prebuilds/${prebuild}/pty.node`,
    ];
    if (manifest.platform === "win32") {
      for (const name of [
        "conpty.node", "conpty_console_list.node", "conpty/conpty.dll",
        "conpty/OpenConsole.exe", "winpty-agent.exe", "winpty.dll",
      ]) required.push(`pty/node_modules/node-pty/prebuilds/${prebuild}/${name}`);
    } else {
      required.push(`pty/node_modules/node-pty/prebuilds/${prebuild}/spawn-helper`);
    }
    if (manifest.backend === "node-helper") {
      if (manifest.nodeMajor !== 22) throw new Error("helper must carry Node 22");
      required.push("pty/helper.cjs", `runtime/${manifest.platform === "win32" ? "node.exe" : "node"}`);
    } else if (manifest.nodeMajor !== null) throw new Error("direct backend must not declare a helper runtime");

    const seen = new Set();
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.path)) {
        throw new Error("invalid or duplicate file entry");
      }
      seen.add(entry.path);
      if (path.posix.isAbsolute(entry.path) || entry.path.split("/").includes("..") || entry.path.includes("\\")) {
        throw new Error(`unsafe path: ${entry.path}`);
      }
      const file = path.join(outDir, ...entry.path.split("/"));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`missing file: ${entry.path}`);
      if (fs.statSync(file).size !== entry.size || hashFile(file) !== entry.sha256) {
        throw new Error(`hash mismatch: ${entry.path}`);
      }
    }
    for (const requiredPath of required) if (!seen.has(requiredPath)) throw new Error(`required file absent: ${requiredPath}`);
    const actual = [...walkFiles(path.join(outDir, "pty")), ...walkFiles(path.join(outDir, "runtime"))]
      .map((file) => slash(path.relative(outDir, file))).sort();
    const declared = [...seen].sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error("unlisted or missing packaged files");
    // 只有 Darwin 主机的 mode 位可信；跨平台复制布局不能拿 Windows stat 冒充 macOS 校验。
    if (manifest.platform === "darwin" && (host.platform ?? process.platform) === "darwin") {
      const helper = path.join(
        outDir, "pty", "node_modules", "node-pty", "prebuilds", prebuild, "spawn-helper",
      );
      const mode = (host.stat ?? fs.statSync)(helper).mode;
      if ((mode & 0o111) === 0) throw new Error("spawn-helper is not executable");
    }
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`NATIVE_LAYOUT: ${detail}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const outDir = process.argv[2];
  if (!outDir || !path.isAbsolute(outDir)) {
    console.error("用法: node scripts/verify-native-layout.mjs <绝对发行目录> [platform] [arch]");
    process.exit(1);
  }
  verifyNativeLayout(outDir, process.argv[3], process.argv[4]).then(() => {
    console.log(`✔ 原生 PTY 布局与 SHA-256 校验通过: ${outDir}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
