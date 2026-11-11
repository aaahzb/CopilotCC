import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 在当前 Windows 上定位随系统提供的 .NET Framework C# 编译器。 @returns csc 绝对路径。 */
export function findFrameworkCompiler() {
  const windir = process.env.WINDIR || "C:/Windows";
  const compiler = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!fs.existsSync(compiler)) throw new Error(`DOTNET_FRAMEWORK_CSC_MISSING: ${compiler}`);
  return compiler;
}

/** 运行一次进程并把 stdout/stderr 原样带出。 @returns spawnSync 结果。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

/** 编译生产启动器源码与独立测试入口并执行 C# 行为测试。 @returns 进程退出码。 */
export function runPortableLauncherTests() {
  if (process.platform !== "win32") throw new Error("PORTABLE_LAUNCHER_TESTS_WINDOWS_ONLY");
  const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-portable-launcher-test-"));
  try {
    const generated = path.join(temp, "PortablePayloadInfo.cs");
    const testExe = path.join(temp, "PortableLauncherTests.exe");
    fs.writeFileSync(generated, `namespace CopilotCC.Portable {
  internal static class PortablePayloadInfo {
    internal const string PayloadHash = "${"0".repeat(64)}";
  }
}
`, "utf8");
    const framework = path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
    const references = [
      "System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
      "System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll", "System.Runtime.Serialization.dll",
    ].map((name) => `/reference:${path.join(framework, name)}`);
    const args = [
      "/nologo", "/utf8output", "/target:exe", "/platform:x64", "/optimize+",
      `/out:${testExe}`, "/main:CopilotCC.Portable.Tests.Program",
      ...references,
      path.join(bridgeRoot, "launcher", "PortableRuntime.cs"),
      path.join(bridgeRoot, "launcher", "PortableLauncher.cs"),
      path.join(bridgeRoot, "launcher", "PortableLauncherTests.cs"),
      generated,
    ];
    const compiled = run(findFrameworkCompiler(), args);
    if (compiled.error || compiled.status !== 0) return compiled.status ?? 1;
    const tested = run(testExe, [], { cwd: temp });
    return tested.error ? 1 : tested.status ?? 1;
  } finally {
    // 只清理本轮 mkdtemp 创建的隔离编译与测试目录。
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) process.exitCode = runPortableLauncherTests();
