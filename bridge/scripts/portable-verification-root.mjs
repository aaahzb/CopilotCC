import * as path from "node:path";

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
