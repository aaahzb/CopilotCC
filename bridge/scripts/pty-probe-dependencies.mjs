import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDarwinSpawnHelperExecutable } from "./pty-native-permissions.mjs";

const PACKAGES = ["node-pty", "node-addon-api"];
const COMPLETE_MARKER = ".ccc-pty-probe-dependencies-complete";

/**
 * 暂存两种 PTY 探针路线共用的依赖；完整结果可复用，半成品不可静默接续。
 * @param {string} bridgeRoot 含 node_modules 的桥接根目录。
 * @param {string} modules 一次性探针根目录下的 node_modules 目标。
 * @param {{platform?:string,arch?:string,chmod?:(file:string,mode:number)=>void}} [runtime] 可注入的宿主参数。
 * @returns {void}
 * @throws {Error} 目标存在未完成副本，或源依赖复制、Darwin 权限修复失败。
 */
export function stagePtyDependencies(bridgeRoot, modules, runtime = {}) {
  const marker = path.join(modules, COMPLETE_MARKER);
  if (fs.existsSync(marker)) return;

  const platform = runtime.platform ?? process.platform;
  const arch = runtime.arch ?? process.arch;
  fs.mkdirSync(modules, { recursive: true });
  for (const name of PACKAGES) {
    const destination = path.join(modules, name);
    // 没有完成标记时，任何同名目录都可能是上次中断留下的半成品。
    if (fs.existsSync(destination)) {
      throw new Error(`PTY_PROBE_DEPENDENCIES_INCOMPLETE:${name}`);
    }
    fs.cpSync(path.join(bridgeRoot, "node_modules", name), destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  if (platform === "darwin") {
    ensureDarwinSpawnHelperExecutable(
      path.join(modules, "node-pty"),
      `${platform}-${arch}`,
      runtime.chmod ?? fs.chmodSync,
    );
  }
  // 权限修复也必须先成功；否则没有标记，回退不会把不完整副本当成完成品。
  fs.writeFileSync(marker, "complete\n", { encoding: "utf8", flag: "wx" });
}
