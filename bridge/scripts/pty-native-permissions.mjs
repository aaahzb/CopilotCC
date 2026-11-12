import * as path from "node:path";

/**
 * 恢复 node-pty 1.1.0 发布包遗漏的 Darwin spawn-helper 执行位。
 * @param {string} packageRoot 已暂存或已打包的 node-pty 根目录。
 * @param {"darwin-arm64"|"darwin-x64"} prebuild 目标预编译目录。
 * @param {(file: string, mode: number) => void} chmod 权限设置函数，测试可注入。
 * @returns {string} 被修复的辅助程序绝对路径。
 * @throws {Error} 目标目录不受支持，或辅助程序缺失、权限设置失败。
 */
export function ensureDarwinSpawnHelperExecutable(packageRoot, prebuild, chmod) {
  if (!["darwin-arm64", "darwin-x64"].includes(prebuild)) {
    throw new Error(`NATIVE_LAYOUT: unsupported Darwin prebuild: ${prebuild}`);
  }
  const helper = path.join(packageRoot, "prebuilds", prebuild, "spawn-helper");
  // 只修改发行/探针副本，不改全局缓存，也不改变其他原生文件的权限。
  chmod(helper, 0o755);
  return helper;
}
