import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDarwinSpawnHelperExecutable } from "./pty-native-permissions.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = {
  win: { platform: "win32", arch: "x64", prebuild: "win32-x64", nodeExe: "node.exe" },
  darwin: { platform: "darwin", arch: "arm64", prebuild: "darwin-arm64", nodeExe: "node" },
};

// 同时覆盖主进程 conpty 与关闭时 fork 的 conpty_console_list_agent；二者共用这份 utils.js。
const WINDOWS_LONG_PATH_FALLBACK = String.raw`
// CCC_WINDOWS_LONG_PATH_NATIVE_FALLBACK
(function () {
    if (process.platform !== "win32") return;
    var path = require("path");
    var originalLoadNativeModule = exports.loadNativeModule;
    exports.loadNativeModule = function (name) {
        try {
            return originalLoadNativeModule.call(exports, name);
        } catch (error) {
            if (!/^[A-Za-z0-9_-]+$/.test(name)) throw error;
            var nativePath = path.join(__dirname, "..", "prebuilds", process.platform + "-" + process.arch, name + ".node");
            var resolved = path.win32.resolve(nativePath);
            var extended = resolved.indexOf("\\\\?\\") === 0 ? resolved
                : resolved.indexOf("\\\\") === 0 ? "\\\\?\\UNC\\" + resolved.slice(2)
                : "\\\\?\\" + resolved;
            var nativeModule = { exports: {} };
            process.dlopen(nativeModule, extended);
            return {
                dir: "prebuilds/" + process.platform + "-" + process.arch + "/",
                module: nativeModule.exports
            };
        }
    };
})();
`;

// .app 的 JS 在 Resources，pty.node 与 spawn-helper 则共同位于代码区 MacOS。
const DARWIN_APP_NATIVE_FALLBACK = String.raw`
// CCC_DARWIN_APP_NATIVE_FALLBACK
(function () {
    if (process.platform !== "darwin") return;
    var path = require("path");
    var originalLoadNativeModule = exports.loadNativeModule;
    exports.loadNativeModule = function (name) {
        try {
            return originalLoadNativeModule.call(exports, name);
        } catch (error) {
            if (name !== "pty") throw error;
            var resources = path.resolve(__dirname, "..", "..", "..", "..");
            var contents = path.resolve(resources, "..");
            if (path.basename(resources) !== "Resources" || path.basename(contents) !== "Contents") {
                throw error;
            }
            var nativeDir = path.join(contents, "MacOS");
            return { dir: nativeDir, module: require(path.join(nativeDir, "pty.node")) };
        }
    };
})();
`;

/**
 * 给发行副本的 node-pty 原生加载器追加 Windows 长路径回退。
 * @param {string} packageRoot 已复制的 node-pty 包目录。
 * @returns {void} 原文件结构不符合 pinned node-pty 版本时直接失败。
 */
function patchWindowsLongPathLoader(packageRoot) {
  const utilsPath = path.join(packageRoot, "lib", "utils.js");
  const source = fs.readFileSync(utilsPath, "utf8");
  if (!source.includes("exports.loadNativeModule = loadNativeModule;")
    || source.includes("CCC_WINDOWS_LONG_PATH_NATIVE_FALLBACK")) {
    throw new Error("NATIVE_LAYOUT: unexpected node-pty utils.js");
  }
  fs.writeFileSync(utilsPath, `${source.trimEnd()}\n\n${WINDOWS_LONG_PATH_FALLBACK}\n`, "utf8");
}

/**
 * 给 Darwin 发行副本追加标准 .app 原生加载回退，平面目录仍优先走 node-pty 原逻辑。
 * @param {string} packageRoot 已复制的 node-pty 包目录。
 * @returns {void} 原文件结构不符合 pinned node-pty 版本时直接失败。
 */
function patchDarwinAppLoader(packageRoot) {
  const utilsPath = path.join(packageRoot, "lib", "utils.js");
  const source = fs.readFileSync(utilsPath, "utf8");
  if (!source.includes("exports.loadNativeModule = loadNativeModule;")
    || source.includes("CCC_DARWIN_APP_NATIVE_FALLBACK")) {
    throw new Error("NATIVE_LAYOUT: unexpected node-pty utils.js");
  }
  fs.writeFileSync(utilsPath, `${source.trimEnd()}\n\n${DARWIN_APP_NATIVE_FALLBACK}\n`, "utf8");
}

/** 将路径统一为 manifest 使用的 POSIX 分隔符。 @param value 原生路径。 @returns 斜杠路径。 */
function slash(value) {
  return value.split(path.sep).join("/");
}

/** 递归列出普通文件并拒绝符号链接。 @param root 遍历根目录。 @returns 绝对路径列表。 */
function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`NATIVE_LAYOUT: symlink not allowed: ${full}`);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result.sort();
}

/** 计算文件 SHA-256。 @param file 文件路径。 @returns 小写十六进制摘要。 */
function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 用随包 Node 查询主版本。 @param nodeRuntime Node 可执行文件。 @returns 主版本号。 */
function detectNodeMajor(nodeRuntime) {
  const result = spawnSync(nodeRuntime, ["--version"], { encoding: "utf8", windowsHide: true });
  const match = /^v(\d+)\./.exec((result.stdout || "").trim());
  if (result.error || result.status !== 0 || !match) throw new Error("NODE_22_REQUIRED: unable to execute runtime");
  return Number(match[1]);
}

/** 编译本地 stdin/stdout helper。 @param helperPath 输出 helper.cjs。 @returns 无。 */
function compileHelper(helperPath) {
  const entry = path.join(bridgeRoot, "src", "node-pty-helper.ts");
  const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;
  const command = `bun build ${quote(entry)} --target=node --format=cjs --outfile ${quote(helperPath)}`;
  const result = spawnSync(command, { cwd: bridgeRoot, shell: true, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`PTY_HELPER_BUILD_FAILED: exit ${result.status ?? "unknown"}`);
}

/**
 * 读取真实探针报告并确认它属于当前构建目标。
 * @param {string} reportPath pty-route.json 绝对路径。
 * @param {"win"|"darwin"} target 构建目标。
 * @returns {"bun-node-pty"|"node-helper"} 六项行为全部通过的路线。
 * @throws {Error} 报告缺失、路线失败、行为不完整或平台架构不符。
 */
export function readSuccessfulPtyRoute(reportPath, target) {
  try {
    const expected = TARGETS[target];
    if (!expected || !path.isAbsolute(reportPath)) throw new Error("invalid target or report path");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const backend = report.selectedRoute;
    if (report.schemaVersion !== 1 || report.platform !== expected.platform || report.arch !== expected.arch
      || !["bun-node-pty", "node-helper"].includes(backend)) throw new Error("target or selectedRoute mismatch");
    const route = report.routes?.[backend];
    const behaviors = route?.behaviors ?? {};
    const behaviorKeys = ["initialSize", "inputEcho", "continuousTicks", "chinese", "resize", "exitCode7"];
    if (route?.pass !== true || route.stage !== "complete"
      || !behaviorKeys.every((key) => behaviors[key] === true)) throw new Error("route did not pass all behaviors");
    return backend;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PTY_ROUTE_REPORT: ${detail}`);
  }
}

/**
 * 把经真实行为探针选择的 PTY 路线打包到发行目录。
 * @param {{target:"win"|"darwin",backend:"bun-node-pty"|"node-helper",outDir:string,nodeRuntime:string|null,
 * readNodeMajor?:(nodePath:string)=>number,buildHelper?:(helperPath:string)=>void,
 * chmod?:(file:string,mode:number)=>void}} options 打包参数。
 * @returns {Promise<Record<string,unknown>>} 已写入的 manifest。
 * @throws 目标、运行时、原生文件或 helper 构建不合法时失败。
 */
export async function packagePty(options) {
  const target = TARGETS[options.target];
  if (!target || !["bun-node-pty", "node-helper"].includes(options.backend)) {
    throw new Error("NATIVE_LAYOUT: invalid target or backend");
  }
  if (!path.isAbsolute(options.outDir)) throw new Error("NATIVE_LAYOUT: outDir must be absolute");
  const ptyDir = path.join(options.outDir, "pty");
  const runtimeDir = path.join(options.outDir, "runtime");
  const manifestPath = path.join(options.outDir, "pty-manifest.json");
  if (fs.existsSync(ptyDir) || fs.existsSync(runtimeDir) || fs.existsSync(manifestPath)) {
    throw new Error("NATIVE_LAYOUT: refusing to overwrite existing PTY layout");
  }

  const packageRoot = path.join(bridgeRoot, "node_modules", "node-pty");
  if (!fs.existsSync(path.join(packageRoot, "package.json"))) throw new Error("NATIVE_LAYOUT: node-pty not installed");
  const destination = path.join(ptyDir, "node_modules", "node-pty");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(packageRoot, destination, {
    recursive: true, force: false, errorOnExist: true,
    filter: (source) => {
      const relative = slash(path.relative(packageRoot, source));
      if (!relative.startsWith("prebuilds/")) return true;
      const parts = relative.split("/");
      return parts.length === 1 || parts[1] === target.prebuild;
    },
  });
  if (options.target === "win") {
    patchWindowsLongPathLoader(destination);
  } else {
    ensureDarwinSpawnHelperExecutable(
      destination,
      target.prebuild,
      options.chmod ?? fs.chmodSync,
    );
    patchDarwinAppLoader(destination);
  }
  // node-pty 声明的运行时依赖也随包携带，不能依赖项目或用户机器的 node_modules。
  const addonApiRoot = path.join(bridgeRoot, "node_modules", "node-addon-api");
  if (!fs.existsSync(path.join(addonApiRoot, "package.json"))) {
    throw new Error("NATIVE_LAYOUT: node-addon-api not installed");
  }
  fs.cpSync(addonApiRoot, path.join(ptyDir, "node_modules", "node-addon-api"), {
    recursive: true, force: false, errorOnExist: true,
  });
  fs.writeFileSync(path.join(ptyDir, "package.json"), '{"private":true}\n', { encoding: "utf8", flag: "wx" });

  let nodeMajor = null;
  if (options.backend === "node-helper") {
    if (!options.nodeRuntime || !path.isAbsolute(options.nodeRuntime) || !fs.existsSync(options.nodeRuntime)) {
      throw new Error("NODE_22_REQUIRED: helper needs an absolute Node 22 runtime");
    }
    const readMajor = options.readNodeMajor ?? detectNodeMajor;
    nodeMajor = readMajor(options.nodeRuntime);
    if (nodeMajor !== 22) throw new Error(`NODE_22_REQUIRED: received ${nodeMajor}`);
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimeTarget = path.join(runtimeDir, target.nodeExe);
    fs.copyFileSync(options.nodeRuntime, runtimeTarget, fs.constants.COPYFILE_EXCL);
    if (options.target === "darwin") fs.chmodSync(runtimeTarget, 0o755);
    const buildHelper = options.buildHelper ?? compileHelper;
    buildHelper(path.join(ptyDir, "helper.cjs"));
  }

  const packagedFiles = [...walkFiles(ptyDir), ...walkFiles(runtimeDir)];
  const requiredAddon = path.join(destination, "prebuilds", target.prebuild, "pty.node");
  if (!packagedFiles.includes(requiredAddon)) throw new Error("NATIVE_LAYOUT: missing target pty.node");
  const files = packagedFiles.map((file) => ({
    path: slash(path.relative(options.outDir, file)),
    sha256: hashFile(file),
    size: fs.statSync(file).size,
  }));
  const manifest = {
    schemaVersion: 1,
    backend: options.backend,
    target: options.target,
    platform: target.platform,
    arch: target.arch,
    nodeMajor,
    files,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return manifest;
}
