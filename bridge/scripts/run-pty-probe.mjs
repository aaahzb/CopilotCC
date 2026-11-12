import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stagePtyDependencies } from "./pty-probe-dependencies.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(bridgeRoot, "..");

class ProbeFailure extends Error {
  /**
   * @param {string} stage 失败阶段。
   * @param {string} message 不含进程环境的诊断。
   */
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

/**
 * 解析命令行参数。
 * @param {string[]} argv 原始参数。
 * @returns {{route: string, target: string, root: string}} 规范化参数。
 * @throws {ProbeFailure} 参数缺失或取值无效。
 */
function parseArgs(argv) {
  const values = { route: "auto", target: "win", root: "" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--route", "--target", "--root"].includes(key) || !argv[index + 1]) {
      throw new ProbeFailure("arguments", `未知或不完整参数: ${key}`);
    }
    values[key.slice(2)] = argv[index + 1];
  }
  if (!["auto", "bun", "helper"].includes(values.route)) {
    throw new ProbeFailure("arguments", "route 必须为 auto/bun/helper");
  }
  if (!["win", "darwin"].includes(values.target) || !path.isAbsolute(values.root)) {
    throw new ProbeFailure("arguments", "target 必须为 win/darwin，root 必须为绝对路径");
  }
  return values;
}

/**
 * 创建一次性的项目外探针目录，不覆盖或删除旧证据。
 * @param {string} root 探针根目录。
 * @returns {void}
 * @throws {ProbeFailure} 目录位于项目内、已存在或为盘符根目录。
 */
function prepareRoot(root) {
  const relative = path.relative(projectRoot, root);
  if ((!relative.startsWith("..") && !path.isAbsolute(relative)) || path.parse(root).root === root) {
    throw new ProbeFailure("layout", "探针 root 必须位于项目树外且不能是盘符根目录");
  }
  if (fs.existsSync(root)) throw new ProbeFailure("layout", "探针 root 已存在，拒绝覆盖旧证据");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "cwd"));
}

/**
 * 返回只含终端所需键的环境，避免把 API 配置传入探针。
 * @param {NodeJS.ProcessEnv} additions 探针专用变量。
 * @returns {NodeJS.ProcessEnv} 最小环境。
 */
function minimalEnv(additions) {
  const allowed = [
    "SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
    "LOCALAPPDATA", "PROGRAMDATA", "HOME", "SHELL", "LANG", "LC_ALL", "TERM",
  ];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...additions };
}

/**
 * 仅保留错误末尾，防止构建日志淹没路线记录。
 * @param {string} value 原始输出。
 * @returns {string} 最长 500 字符的诊断。
 */
function diagnostic(value) {
  return value.trim().slice(-500).replace(/[\r\n]+/g, " | ");
}

/**
 * 编译并运行 Bun 直接 node-pty 路线。
 * @param {{target: string, root: string, nodePath: string}} options 探针配置。
 * @returns {Record<string, unknown>} 探针行为结果。
 * @throws {ProbeFailure} 编译、布局或真实行为验证失败。
 */
function runBun(options) {
  const entry = path.join(bridgeRoot, "scripts", "probe-bun-node-pty.ts");
  const executable = path.join(options.root, process.platform === "win32" ? "probe.exe" : "probe");
  const target = options.target === "win" ? "bun-windows-x64" : "bun-darwin-arm64";
  const command = `bun build "${entry}" --compile --target=${target} --outfile "${executable}"`;
  const build = spawnSync(command, {
    cwd: bridgeRoot,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (build.error || build.status !== 0) {
    throw new ProbeFailure("compile", diagnostic(build.error?.message || build.stderr || build.stdout || "Bun 编译失败"));
  }

  const modules = path.join(options.root, "pty", "node_modules");
  stagePtyDependencies(bridgeRoot, modules);
  fs.writeFileSync(path.join(options.root, "pty", "package.json"), '{"private":true}\n', "utf8");
  const child = path.join(options.root, "pty-probe-child.cjs");
  fs.copyFileSync(path.join(bridgeRoot, "scripts", "pty-probe-child.cjs"), child);

  const result = spawnSync(executable, [], {
    cwd: path.join(options.root, "cwd"),
    env: minimalEnv({ PROBE_NODE: options.nodePath, PROBE_CHILD: child, PROBE_CWD: path.join(options.root, "cwd") }),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  fs.writeFileSync(path.join(options.root, "bun-probe-stdout.log"), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(options.root, "bun-probe-stderr.log"), result.stderr || "", "utf8");
  if (result.error || result.status !== 0) {
    const protocolError = (result.stdout || "").split(/\r?\n/).find((item) => item.startsWith("PTY_PROBE_ERROR:"));
    throw new ProbeFailure("runtime", diagnostic(result.error?.message || protocolError || result.stderr || result.stdout || `exit ${result.status}`));
  }
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("PTY_PROBE_RESULT:"));
  if (!line) throw new ProbeFailure("protocol", "缺少 PTY_PROBE_RESULT");
  const parsed = JSON.parse(line.slice("PTY_PROBE_RESULT:".length));
  const behaviors = parsed.behaviors || {};
  for (const key of ["initialSize", "inputEcho", "continuousTicks", "chinese", "resize", "exitCode7"]) {
    if (behaviors[key] !== true) throw new ProbeFailure("behavior", `${key}=false`);
  }
  if (parsed.isolatedCwd !== true || parsed.isolatedNative !== true) {
    throw new ProbeFailure("isolation", "探针读取了项目树内资源或 CWD 未隔离");
  }
  return parsed;
}

/**
 * 编译并运行 Bun 主端 + Node 22 helper 的真实回退路线。
 * @param {{target: string, root: string, nodePath: string}} options 探针配置。
 * @returns {Record<string, unknown>} 与直接路线一致的行为结果。
 * @throws {ProbeFailure} helper/主端编译、原生加载或行为验证失败。
 */
function runHelper(options) {
  const ptyDir = path.join(options.root, "pty");
  const helper = path.join(ptyDir, "helper.cjs");
  fs.mkdirSync(ptyDir, { recursive: true });
  const helperEntry = path.join(bridgeRoot, "src", "node-pty-helper.ts");
  const helperBuild = spawnSync(`bun build "${helperEntry}" --target=node --format=cjs --outfile "${helper}"`, {
    cwd: bridgeRoot,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  fs.writeFileSync(path.join(options.root, "helper-build-stdout.log"), helperBuild.stdout || "", "utf8");
  fs.writeFileSync(path.join(options.root, "helper-build-stderr.log"), helperBuild.stderr || "", "utf8");
  if (helperBuild.error || helperBuild.status !== 0) {
    throw new ProbeFailure("compile-helper", diagnostic(helperBuild.error?.message || helperBuild.stderr || helperBuild.stdout || "helper 编译失败"));
  }

  const entry = path.join(bridgeRoot, "scripts", "probe-node-helper.ts");
  const executable = path.join(options.root, process.platform === "win32" ? "probe-helper.exe" : "probe-helper");
  const target = options.target === "win" ? "bun-windows-x64" : "bun-darwin-arm64";
  const probeBuild = spawnSync(`bun build "${entry}" --compile --target=${target} --outfile "${executable}"`, {
    cwd: bridgeRoot,
    shell: true,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (probeBuild.error || probeBuild.status !== 0) {
    throw new ProbeFailure("compile-probe", diagnostic(probeBuild.error?.message || probeBuild.stderr || probeBuild.stdout || "helper 主端探针编译失败"));
  }

  const modules = path.join(ptyDir, "node_modules");
  stagePtyDependencies(bridgeRoot, modules);
  fs.writeFileSync(path.join(ptyDir, "package.json"), '{"private":true}\n', "utf8");
  const child = path.join(options.root, "pty-probe-child.cjs");
  fs.copyFileSync(path.join(bridgeRoot, "scripts", "pty-probe-child.cjs"), child);
  const nativeRoot = path.join(modules, "node-pty");

  const result = spawnSync(executable, [], {
    cwd: path.join(options.root, "cwd"),
    env: minimalEnv({
      PROBE_NODE: options.nodePath,
      PROBE_HELPER: helper,
      PROBE_CHILD: child,
      PROBE_CWD: path.join(options.root, "cwd"),
      PROBE_NATIVE_ROOT: nativeRoot,
    }),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  fs.writeFileSync(path.join(options.root, "helper-probe-stdout.log"), result.stdout || "", "utf8");
  fs.writeFileSync(path.join(options.root, "helper-probe-stderr.log"), result.stderr || "", "utf8");
  if (result.error || result.status !== 0) {
    const protocolError = (result.stdout || "").split(/\r?\n/).find((item) => item.startsWith("PTY_PROBE_ERROR:"));
    throw new ProbeFailure("runtime", diagnostic(result.error?.message || protocolError || result.stderr || result.stdout || `exit ${result.status}`));
  }
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("PTY_PROBE_RESULT:"));
  if (!line) throw new ProbeFailure("protocol", "缺少 helper PTY_PROBE_RESULT");
  const parsed = JSON.parse(line.slice("PTY_PROBE_RESULT:".length));
  const behaviors = parsed.behaviors || {};
  for (const key of ["initialSize", "inputEcho", "continuousTicks", "chinese", "resize", "exitCode7"]) {
    if (behaviors[key] !== true) throw new ProbeFailure("behavior", `${key}=false`);
  }
  if (parsed.isolatedCwd !== true || parsed.isolatedNative !== true) {
    throw new ProbeFailure("isolation", "helper 探针读取了项目树内资源或 CWD 未隔离");
  }
  return parsed;
}

const report = {
  schemaVersion: 1,
  selectedRoute: null,
  platform: process.platform,
  arch: process.arch,
  routes: {},
};
let options;
let exitCode = 1;
try {
  options = parseArgs(process.argv.slice(2));
  prepareRoot(options.root);
  const nodePath = process.env.PROBE_NODE || process.execPath;
  const version = spawnSync(nodePath, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0 || !version.stdout.trim().startsWith("v22.")) {
    throw new ProbeFailure("runtime", "PROBE_NODE 必须指向 Node 22");
  }

  if (options.route === "bun" || options.route === "auto") {
    try {
      const result = runBun({ ...options, nodePath });
      report.routes["bun-node-pty"] = { attempted: true, pass: true, stage: "complete", ...result };
      report.selectedRoute = "bun-node-pty";
      exitCode = 0;
    } catch (error) {
      const failure = error instanceof ProbeFailure ? error : new ProbeFailure("runtime", error.message);
      report.routes["bun-node-pty"] = { attempted: true, pass: false, stage: failure.stage, error: diagnostic(failure.message) };
      if (options.route === "bun") throw failure;
    }
  }
  if (exitCode !== 0 && (options.route === "helper" || options.route === "auto")) {
    try {
      const result = runHelper({ ...options, nodePath });
      report.routes["node-helper"] = { attempted: true, pass: true, stage: "complete", ...result };
      report.selectedRoute = "node-helper";
      exitCode = 0;
    } catch (error) {
      const failure = error instanceof ProbeFailure ? error : new ProbeFailure("runtime", error.message);
      report.routes["node-helper"] = { attempted: true, pass: false, stage: failure.stage, error: diagnostic(failure.message) };
      throw failure;
    }
  }
} catch (error) {
  const failure = error instanceof ProbeFailure ? error : new ProbeFailure("runtime", error.message);
  if (!report.routes["bun-node-pty"] && options?.route === "bun") {
    report.routes["bun-node-pty"] = { attempted: true, pass: false, stage: failure.stage, error: diagnostic(failure.message) };
  }
  console.error(`PTY 探针失败 [${failure.stage}]: ${diagnostic(failure.message)}`);
}

if (options?.root && fs.existsSync(options.root)) {
  fs.writeFileSync(path.join(options.root, "pty-route.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
process.exit(exitCode);
