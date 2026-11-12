import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyNativeLayout } from "./verify-native-layout.mjs";

/**
 * 将已校验的平面 Darwin PTY 发行包 staged 为标准 .app 代码/资源布局。
 * @param {{sourceDir:string,appPath:string}} options 平面发行目录与目标 .app 绝对路径。
 * @returns {Promise<{backend:"bun-node-pty"|"node-helper"}>} manifest 选定的 PTY 后端。
 * @throws {Error} 源布局非法、目标已存在或复制失败时抛 NATIVE_LAYOUT。
 */
export async function stageMacPty(options) {
  try {
    if (!path.isAbsolute(options.sourceDir) || !path.isAbsolute(options.appPath)) {
      throw new Error("sourceDir and appPath must be absolute");
    }
    await verifyNativeLayout(options.sourceDir, "darwin", "arm64");
    const manifest = JSON.parse(fs.readFileSync(path.join(options.sourceDir, "pty-manifest.json"), "utf8"));
    const macos = path.join(options.appPath, "Contents", "MacOS");
    const resources = path.join(options.appPath, "Contents", "Resources");
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(resources, { recursive: true });

    // JS、构建描述与 manifest 全是资源；只有 Mach-O 留在 Contents/MacOS。
    fs.cpSync(path.join(options.sourceDir, "pty"), path.join(resources, "pty"), {
      recursive: true, force: false, errorOnExist: true,
    });
    fs.copyFileSync(
      path.join(options.sourceDir, "pty-manifest.json"),
      path.join(resources, "pty-manifest.json"),
      fs.constants.COPYFILE_EXCL,
    );
    const prebuild = path.join(
      resources, "pty", "node_modules", "node-pty", "prebuilds", "darwin-arm64",
    );
    for (const name of ["pty.node", "spawn-helper"]) {
      const destination = path.join(macos, name);
      if (fs.existsSync(destination)) throw new Error(`refusing to overwrite ${name}`);
      fs.renameSync(path.join(prebuild, name), destination);
    }
    if (manifest.backend === "node-helper") {
      const nodeTarget = path.join(macos, "node");
      fs.copyFileSync(path.join(options.sourceDir, "runtime", "node"), nodeTarget, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(nodeTarget, 0o755);
    }
    return { backend: manifest.backend };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`NATIVE_LAYOUT: ${detail}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const [sourceDir, appPath] = process.argv.slice(2);
  if (!sourceDir || !appPath || !path.isAbsolute(sourceDir) || !path.isAbsolute(appPath)) {
    console.error("用法: node scripts/stage-mac-pty.mjs <绝对发行目录> <绝对 .app 路径>");
    process.exit(1);
  }
  stageMacPty({ sourceDir, appPath }).then(() => {
    console.log("✔ macOS PTY 代码/资源布局组装完成");
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
