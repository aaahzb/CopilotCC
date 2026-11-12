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

/**
 * 校验 macOS .app 的代码/资源分离、manifest 完整性和未签名原生文件哈希。
 * @param {string} appPath 待校验的 .app 绝对路径。
 * @param {{platform?:string,stat?:(file:string)=>{mode:number}}} [host] 可注入的 Darwin 宿主参数。
 * @returns {Promise<{backend:"bun-node-pty"|"node-helper",nativeFiles:string[]}>} 后端与待签内层代码相对路径。
 * @throws {Error} 非代码文件位于 MacOS、文件缺失/额外、摘要或执行位不符时抛 NATIVE_LAYOUT。
 */
export async function verifyMacAppLayout(appPath, host = {}) {
  try {
    if (!path.isAbsolute(appPath)) throw new Error("app path must be absolute");
    const contents = path.join(appPath, "Contents");
    const macos = path.join(contents, "MacOS");
    const resources = path.join(contents, "Resources");
    const actualCode = walkFiles(macos).map((file) => slash(path.relative(macos, file))).sort();
    const supportedCode = new Set([
      "ccc-bridge", "pty.node", "spawn-helper", "node", "traybin/tray_darwin_release",
    ]);
    // codesign 会把 MacOS 下的任意数据或自定义嵌套层级当成子组件，必须在签名前拒绝。
    for (const relative of actualCode) {
      if (!supportedCode.has(relative)) {
        throw new Error(`non-code file in Contents/MacOS or unsupported nested code: ${relative}`);
      }
    }

    const manifestPath = path.join(resources, "pty-manifest.json");
    if (!fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) {
      throw new Error("pty-manifest.json must be a regular file in Resources");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || !["bun-node-pty", "node-helper"].includes(manifest.backend)
      || manifest.target !== "darwin" || manifest.platform !== "darwin" || manifest.arch !== "arm64"
      || !Array.isArray(manifest.files)) throw new Error("invalid macOS app manifest");
    const helperBackend = manifest.backend === "node-helper";
    if (helperBackend ? manifest.nodeMajor !== 22 : manifest.nodeMajor !== null) {
      throw new Error("manifest Node runtime mismatch");
    }

    const moved = new Map([
      ["pty/node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "pty.node"],
      ["pty/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper", "spawn-helper"],
      ...(helperBackend ? [["runtime/node", "node"]] : []),
    ]);
    const required = [
      "pty/package.json",
      "pty/node_modules/node-pty/package.json",
      "pty/node_modules/node-pty/lib/index.js",
      "pty/node_modules/node-pty/lib/utils.js",
      "pty/node_modules/node-pty/lib/unixTerminal.js",
      "pty/node_modules/node-addon-api/package.json",
      "pty/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "pty/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      ...(helperBackend ? ["pty/helper.cjs", "runtime/node"] : []),
    ];
    const seen = new Set();
    for (const entry of manifest.files) {
      if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || seen.has(entry.path)) {
        throw new Error("invalid or duplicate file entry");
      }
      seen.add(entry.path);
      if (path.posix.isAbsolute(entry.path) || entry.path.split("/").includes("..")
        || entry.path.includes("\\") || (!moved.has(entry.path) && !entry.path.startsWith("pty/"))) {
        throw new Error(`unsafe or unexpected path: ${entry.path}`);
      }
      const file = moved.has(entry.path)
        ? path.join(macos, moved.get(entry.path))
        : path.join(resources, ...entry.path.split("/"));
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`not a regular file: ${entry.path}`);
      if (stat.size !== entry.size || hashFile(file) !== entry.sha256) {
        throw new Error(`hash mismatch: ${entry.path}`);
      }
    }
    for (const requiredPath of required) if (!seen.has(requiredPath)) {
      throw new Error(`required file absent: ${requiredPath}`);
    }

    const actualResources = [
      ...walkFiles(path.join(resources, "pty")), ...walkFiles(path.join(resources, "runtime")),
    ].map((file) => slash(path.relative(resources, file))).sort();
    const expectedResources = [...seen].filter((entry) => !moved.has(entry)).sort();
    if (JSON.stringify(actualResources) !== JSON.stringify(expectedResources)) {
      throw new Error("unlisted or missing resource files");
    }
    const nativeFiles = [
      "pty.node", "spawn-helper", ...(helperBackend ? ["node"] : []), "traybin/tray_darwin_release",
    ];
    const expectedCode = ["ccc-bridge", ...nativeFiles].sort();
    if (JSON.stringify(actualCode) !== JSON.stringify(expectedCode)) {
      throw new Error("unlisted or missing code files");
    }
    if ((host.platform ?? process.platform) === "darwin") {
      for (const relative of ["ccc-bridge", "spawn-helper", ...(helperBackend ? ["node"] : []),
        "traybin/tray_darwin_release"]) {
        const mode = (host.stat ?? fs.statSync)(path.join(macos, ...relative.split("/"))).mode;
        if ((mode & 0o111) === 0) throw new Error(`${relative} is not executable`);
      }
    }
    return { backend: manifest.backend, nativeFiles };
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
