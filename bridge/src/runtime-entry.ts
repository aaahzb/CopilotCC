import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config";
import { UUID_RE } from "./protocol";

export interface TerminalChildCommand {
  executable: string;
  prefixArgs: string[];
}

/**
 * 校验绿色单文件启动器发布的负载目录。
 * @param value 启动器传入的目录；空值表示传统完整目录布局
 * @param configRoot 当前配置根目录，默认读取 CCC_BRIDGE_HOME
 * @returns 校验通过的绝对目录；传统布局返回 null
 * @throws 目录越界、名称非法、为链接或缺清单时抛 PORTABLE_RUNTIME_DIR
 */
export function resolvePortableRuntimeDirectory(
  value: string | undefined,
  configRoot: string = configDir(),
): string | null {
  if (!value) return null;
  try {
    const resolved = path.resolve(value);
    const runtimeRoot = path.resolve(configRoot, "runtime");
    const name = path.basename(resolved);
    const manifest = path.join(resolved, "payload-manifest.json");
    if (path.dirname(resolved) !== runtimeRoot || !/^[a-f0-9]{64}$/.test(name)) {
      throw new Error("invalid portable path");
    }
    // junction 和符号链接都不能被当成启动器发布的私有版本目录。
    if (fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isDirectory()) {
      throw new Error("portable directory is not a real directory");
    }
    if (fs.lstatSync(manifest).isSymbolicLink() || !fs.lstatSync(manifest).isFile()) {
      throw new Error("portable manifest is not a regular file");
    }
    return resolved;
  } catch {
    throw new Error("PORTABLE_RUNTIME_DIR");
  }
}

/**
 * 定位已实测原生 PTY 包，开发态不能误用 Node 的安装目录。
 * @param entry 当前生产入口路径，默认 process.argv[1]
 * @param executable 当前运行时或编译桥接路径，默认 process.execPath
 * @param portableValue 单文件启动器发布的负载目录
 * @param configRoot 当前配置根目录
 * @returns 开发为项目 dist/native-dev；便携为已校验版本目录；传统编译为 exe 所在目录
 * @throws 便携变量非法时抛 PORTABLE_RUNTIME_DIR，不回退到未知组件
 */
export function terminalNativeDirectory(
  entry: string = process.argv[1] ?? "",
  executable: string = process.execPath,
  portableValue: string | undefined = process.env.CCC_PORTABLE_RUNTIME_DIR,
  configRoot: string = configDir(),
): string {
  if (entry && path.resolve(entry).endsWith(".ts")) return path.resolve("dist/native-dev");
  const portable = resolvePortableRuntimeDirectory(portableValue, configRoot);
  return portable ?? path.dirname(path.resolve(executable));
}

/**
 * 区分 tsx 开发入口与编译桥接 exe，tsx 从入口所在 bridge 包解析而非依赖 CWD。
 * @param entry 当前生产入口路径，默认 process.argv[1]
 * @param executable 当前运行时，默认 process.execPath
 * @param platform 当前平台；Windows 编译态使用 Console 包装，避免复用 GUI 托盘 exe
 * @param portableValue 单文件启动器发布的负载目录
 * @param configRoot 当前配置根目录
 * @returns 私有包装进程的可执行文件和前缀参数
 * @throws 便携目录非法时抛 PORTABLE_RUNTIME_DIR
 */
export function terminalChildCommand(
  entry: string = process.argv[1] ?? "",
  executable: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  portableValue: string | undefined = process.env.CCC_PORTABLE_RUNTIME_DIR,
  configRoot: string = configDir(),
): TerminalChildCommand {
  const absoluteEntry = entry ? path.resolve(entry) : "";
  if (absoluteEntry.endsWith(".ts")) {
    return {
      executable,
      prefixArgs: [
        path.resolve(path.dirname(absoluteEntry), "..", "node_modules", "tsx", "dist", "cli.mjs"),
        absoluteEntry,
      ],
    };
  }
  if (platform === "win32") {
    // 单文件和传统布局都必须使用 Console 包装，不能复用 GUI 托盘 exe。
    const nativeDirectory = terminalNativeDirectory(
      absoluteEntry, executable, portableValue, configRoot,
    );
    return { executable: path.join(nativeDirectory, "ccc-terminal.exe"), prefixArgs: [] };
  }
  return { executable, prefixArgs: [] };
}

/**
 * 生成旧版 CLI command Hook 的固定入口，leaseId 只能是规范 UUID。
 * @param leaseId 当前 lease
 * @param command 可注入的开发/编译入口
 * @returns 不含 token 的 shell 命令
 * @throws leaseId 非规范 UUID 时抛出 TERMINAL_HOOK_COMMAND
 */
export function terminalHookCommand(
  leaseId: string,
  command: TerminalChildCommand = terminalChildCommand(),
): string {
  if (!UUID_RE.test(leaseId)) throw new Error("TERMINAL_HOOK_COMMAND");
  return [command.executable, ...command.prefixArgs, "--terminal-hook", leaseId]
    .map((part) => process.platform === "win32"
      ? `"${part.replace(/"/g, "")}"`
      : `'${part.replace(/'/g, `'"'"'`)}'`)
    .join(" ");
}
