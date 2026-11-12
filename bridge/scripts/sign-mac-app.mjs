import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyMacAppLayout } from "./verify-native-layout.mjs";

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
  const layout = await verifyMacAppLayout(options.appPath);
  const nativeFiles = layout.nativeFiles.map((file) => path.join(macos, ...file.split("/")));
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
