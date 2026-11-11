import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** 递归列出普通文件。 @param root 根目录。 @returns 绝对路径列表。 */
function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

/** 为日志生成不含秘密的固定命令文本。 @param args codesign 参数。 @returns 可比较命令。 */
function displayCommand(args) {
  return `codesign ${args.map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(" ")}`;
}

/**
 * 生成并执行 macOS 内层到整包的 ad-hoc 签名顺序。
 * @param {{appPath:string,dryRun?:boolean,codesign?:(args:string[])=>void|Promise<void>}} options 签名参数。
 * @returns {Promise<string[]>} 实际执行顺序；dryRun 只返回计划。
 * @throws 原生文件缺失或 codesign 非零退出时失败。
 */
export async function runMacPackaging(options) {
  const macos = path.join(options.appPath, "Contents", "MacOS");
  const main = path.join(macos, "ccc-bridge");
  const nativeNames = new Set(["spawn-helper", "node", "tray_darwin_release"]);
  const nativeFiles = walkFiles(macos).filter((file) => file !== main
    && (file.endsWith(".node") || nativeNames.has(path.basename(file))));
  nativeFiles.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
  if (!nativeFiles.some((file) => file.endsWith(".node")) || !fs.existsSync(main)) {
    throw new Error("NATIVE_LAYOUT: macOS signing needs pty.node and ccc-bridge");
  }
  const sign = options.codesign ?? ((args) => {
    const result = spawnSync("codesign", args, { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`CODESIGN_FAILED: exit ${result.status ?? "unknown"}`);
  });
  const commands = [];
  const execute = async (args) => {
    commands.push(displayCommand(args));
    if (!options.dryRun) await sign(args);
  };
  for (const file of nativeFiles) await execute(["--force", "-s", "-", file]);
  await execute(["--force", "-s", "-", main]);
  await execute(["--force", "-s", "-", options.appPath]);
  await execute(["--verify", "--deep", "--strict", "--verbose=2", options.appPath]);
  return commands;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const appPath = process.argv[2];
  if (!appPath || !path.isAbsolute(appPath)) {
    console.error("用法: node scripts/sign-mac-app.mjs <绝对 .app 路径>");
    process.exit(1);
  }
  runMacPackaging({ appPath }).then((commands) => {
    for (const command of commands) console.log(`✔ ${command}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
