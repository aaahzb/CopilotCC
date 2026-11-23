import * as path from "node:path";

const LEGACY_LOCAL_APPROVED_ROOT = "D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110";

/**
 * 返回本机明确批准的验收根目录；环境变量未设置时兼容既有本机路径。
 * @param {NodeJS.ProcessEnv} env 环境变量。
 * @returns {string} 规范化后的绝对批准根目录。
 * @throws {Error} CCC_VERIFY_ROOT 不是绝对路径时抛出。
 */
export function localApprovedVerificationRoot(env = process.env) {
  const configured = env.CCC_VERIFY_ROOT;
  if (!configured) return LEGACY_LOCAL_APPROVED_ROOT;
  if (!path.isAbsolute(configured)) throw new Error("CCC_VERIFY_ROOT: 必须是绝对路径");
  return path.resolve(configured);
}

/**
 * 判断 child 是否严格位于 parent 内。
 * @param {string} parent 父目录。
 * @param {string} child 待判断路径。
 * @returns {boolean} 严格子路径返回 true，同目录或越界返回 false。
 */
function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 解析生命周期验收允许使用的新目录。
 * @param {string} value 用户或工作流传入的 --root。
 * @param {{localApprovedRoot:string,runnerTemp:string,projectRoot:string,githubActions:boolean}} options 白名单与运行环境。
 * @returns {string} 规范化后的绝对验收目录。
 * @throws {Error} 缺参数、等于白名单根、越出白名单或落入项目树时抛出固定错误。
 */
export function resolvePortableVerificationRoot(value, options) {
  if (!value || typeof value !== "string") throw new Error("PORTABLE_VERIFY_ROOT: --root 必须提供");
  const root = path.resolve(value);
  const projectRoot = path.resolve(options.projectRoot);
  if (root === projectRoot || inside(projectRoot, root)) {
    throw new Error("PORTABLE_VERIFY_ROOT: root 不得位于项目树内");
  }
  const approved = [path.resolve(options.localApprovedRoot)];
  if (options.githubActions && options.runnerTemp) approved.push(path.resolve(options.runnerTemp));
  if (approved.some((parent) => root === parent)) {
    throw new Error("PORTABLE_VERIFY_ROOT: root 必须严格位于批准目录内，不能使用根目录本身");
  }
  if (!approved.some((parent) => inside(parent, root))) {
    throw new Error("PORTABLE_VERIFY_ROOT: root 必须位于本机批准目录，或 GitHub Actions 的 RUNNER_TEMP 内");
  }
  return root;
}

/**
 * 在创建进程前拒绝已知会触发传统 Win32 路径上限的真实 Chrome 验收目录。
 * @param {string} root 本次全新验收目录。
 * @param {string} extensionId 固定扩展 ID。
 * @param {{portable:boolean,platform?:string}} options 是否包含绿色内层路径及目标平台。
 * @throws {Error} 任一必需路径超过 259 字符时抛出，并列出实际路径。
 */
export function assertEmbeddedVerificationPaths(root, extensionId, { portable, platform = process.platform }) {
  if (platform !== "win32") return;
  const candidates = [{
    label: "Chrome 扩展存储锁",
    value: path.join(root, "chrome-profile", "Default", "Local Extension Settings", extensionId, "LOCK"),
  }];
  if (portable) candidates.push({
    label: "绿色内层可执行文件",
    value: path.join(root, "home", "runtime", "0".repeat(64), "ccc-bridge.exe"),
  });
  const tooLong = candidates.filter((candidate) => candidate.value.length > 259);
  if (tooLong.length > 0) {
    throw new Error(`EMBEDDED_VERIFY_PATH: 超过 Windows 传统路径上限，请改用批准根目录下更短的新目录：${
      tooLong.map((candidate) => `${candidate.label}(${candidate.value.length})=${candidate.value}`).join("；")}`);
  }
}
