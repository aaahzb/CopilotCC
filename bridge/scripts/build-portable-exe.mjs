import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findFrameworkCompiler } from "./run-portable-launcher-tests.mjs";

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["ccc-bridge.exe", "ccc-terminal.exe", "pty-manifest.json"];

/** 计算文件或缓冲区 SHA-256。 @param value 输入。 @returns 小写十六进制摘要。 */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 将路径转换为负载统一格式。 @param value 原生路径。 @returns 正斜杠路径。 */
function slash(value) {
  return value.split(path.sep).join("/");
}

/** 递归列出普通文件并拒绝所有链接。 @param root 负载根目录。 @returns 排序后的绝对文件列表。 */
function walkFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`PORTABLE_PAYLOAD: link rejected: ${full}`);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
    else throw new Error(`PORTABLE_PAYLOAD: non-regular entry: ${full}`);
  }
  return result.sort();
}

/**
 * 从完整 Windows 中间目录生成内容清单和稳定版本哈希。
 * @param {string} sourceDir 完整发行目录。
 * @returns {{manifest:Record<string,unknown>,payloadHash:string}} 清单与内容哈希。
 * @throws 缺必要文件、已有清单或存在链接时抛 PORTABLE_PAYLOAD。
 */
export function createPayloadManifest(sourceDir) {
  try {
    if (!path.isAbsolute(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error("source directory is invalid");
    }
    if (fs.existsSync(path.join(sourceDir, "payload-manifest.json"))) {
      throw new Error("source already contains payload-manifest.json");
    }
    const files = walkFiles(sourceDir).map((file) => ({
      path: slash(path.relative(sourceDir, file)),
      sha256: sha256(fs.readFileSync(file)),
      size: fs.statSync(file).size,
    })).sort((a, b) => a.path.localeCompare(b.path));
    const paths = new Set(files.map((file) => file.path));
    for (const required of REQUIRED) if (!paths.has(required)) throw new Error(`missing ${required}`);
    if (files.some((file) => !file.path || file.path.startsWith("/") || file.path.includes("\\")
      || file.path.split("/").some((part) => !part || part === "." || part === ".."))) {
      throw new Error("unsafe payload path");
    }
    const payloadHash = sha256(JSON.stringify(files));
    return {
      payloadHash,
      manifest: {
        schemaVersion: 1,
        product: "CopilotCC",
        payloadHash,
        mainExecutable: "ccc-bridge.exe",
        terminalExecutable: "ccc-terminal.exe",
        files,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`PORTABLE_PAYLOAD: ${detail}`);
  }
}

/**
 * 以固定块去重负载，同时保留原始文件清单供启动后逐文件复核。
 * @param {string} payloadDir 已写入清单的完整临时负载。
 * @param {{files:Array<{path:string,size:number}>}} manifest 原始文件清单。
 * @param {string} archiveDir 仅用于 ZIP 的独立目录。
 * @returns {{storedBytes:number}} 唯一数据块的未压缩总字节数。
 */
function createPackedArchive(payloadDir, manifest, archiveDir) {
  const chunkSize = 1024 * 1024;
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(path.join(payloadDir, "payload-manifest.json"), path.join(archiveDir, "payload-manifest.json"));
  const pack = path.join(archiveDir, "payload-content.bin");
  const output = fs.openSync(pack, "wx");
  const unique = new Map();
  const files = [];
  let storedBytes = 0;
  try {
    for (const file of manifest.files) {
      const input = fs.openSync(path.join(payloadDir, ...file.path.split("/")), "r");
      const chunks = [];
      let remaining = file.size;
      try {
        while (remaining > 0) {
          const wanted = Math.min(chunkSize, remaining);
          const buffer = Buffer.allocUnsafe(wanted);
          let read = 0;
          while (read < wanted) {
            const count = fs.readSync(input, buffer, read, wanted - read, null);
            if (count <= 0) throw new Error(`PORTABLE_PAYLOAD: truncated ${file.path}`);
            read += count;
          }
          const key = `${sha256(buffer)}:${wanted}`;
          let chunk = unique.get(key);
          if (!chunk) {
            chunk = { offset: storedBytes, size: wanted };
            let written = 0;
            while (written < wanted) written += fs.writeSync(output, buffer, written, wanted - written, null);
            unique.set(key, chunk);
            storedBytes += wanted;
          }
          chunks.push(chunk);
          remaining -= wanted;
        }
      } finally {
        fs.closeSync(input);
      }
      files.push({ path: file.path, size: file.size, chunks });
    }
  } finally {
    fs.closeSync(output);
  }
  fs.writeFileSync(path.join(archiveDir, "payload-storage.json"), `${JSON.stringify({
    schemaVersion: 1, contentPack: "payload-content.bin", files,
  })}\n`, "utf8");
  return { storedBytes };
}

/** 定位 7-Zip。 @returns 7z 可执行路径。 */
function findSevenZip() {
  const candidates = [
    process.env.CCC_SEVEN_ZIP,
    "C:/Program Files/7-Zip/7z.exe",
    "C:/Program Files (x86)/7-Zip/7z.exe",
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("PORTABLE_BUILD: 7-Zip not found; set CCC_SEVEN_ZIP");
}

/** 执行构建工具。 @param command 命令。 @param args 参数。 @param options 附加选项。 @returns 无。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-4000);
    throw new Error(`PORTABLE_BUILD: ${path.basename(command)} failed (${result.status ?? "error"}): ${output}`);
  }
}

/**
 * 压缩完整负载并编译只含一个 exe 的绿色启动器。
 * @param {{sourceDir:string,outDir:string,sevenZip?:string,csc?:string}} options 构建参数。
 * @returns {Promise<{portableExe:string,payloadHash:string,bytes:number,sha256:string,zipBytes:number,storedBytes:number}>} 实测构建结果。
 * @throws 输入、压缩、编译或公开目录不合法时失败。
 */
export async function buildPortableExe(options) {
  if (process.platform !== "win32") throw new Error("PORTABLE_BUILD: Windows only");
  const sourceDir = path.resolve(options.sourceDir);
  const outDir = path.resolve(options.outDir);
  createPayloadManifest(sourceDir);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).some((name) => name !== "CopilotCC.exe")) {
    throw new Error("PORTABLE_BUILD: output directory contains non-portable files");
  }
  const temp = fs.mkdtempSync(path.join(bridgeRoot, "dist", ".portable-build-"));
  try {
    const payloadDir = path.join(temp, "payload");
    fs.cpSync(sourceDir, payloadDir, {
      recursive: true, force: false, errorOnExist: true,
      filter: (source) => path.resolve(source) !== outDir && !path.resolve(source).startsWith(`${outDir}${path.sep}`),
    });
    const { manifest, payloadHash } = createPayloadManifest(payloadDir);
    fs.writeFileSync(path.join(payloadDir, "payload-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const archiveDir = path.join(temp, "archive");
    const { storedBytes } = createPackedArchive(payloadDir, manifest, archiveDir);
    const zip = path.join(temp, "payload.zip");
    const sevenZip = options.sevenZip || findSevenZip();
    run(sevenZip, ["a", "-tzip", "-mx=9", zip, "*"], { cwd: archiveDir });
    run(sevenZip, ["t", zip], { cwd: temp });

    const generated = path.join(temp, "PortablePayloadInfo.cs");
    fs.writeFileSync(generated, `namespace CopilotCC.Portable {
  internal static class PortablePayloadInfo {
    internal const string PayloadHash = "${payloadHash}";
  }
}
`, "utf8");
    const framework = path.join(process.env.WINDIR || "C:/Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
    const references = [
      "System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
      "System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll", "System.Runtime.Serialization.dll",
    ].map((name) => `/reference:${path.join(framework, name)}`);
    const built = path.join(temp, "CopilotCC.exe");
    const icon = path.join(bridgeRoot, "assets", "icon.ico");
    const compiler = options.csc || findFrameworkCompiler();
    run(compiler, [
      "/nologo", "/utf8output", "/target:winexe", "/platform:x64", "/optimize+",
      `/out:${built}`, `/win32icon:${icon}`, `/resource:${zip},CopilotCC.Payload.zip`,
      ...references,
      path.join(bridgeRoot, "launcher", "PortableRuntime.cs"),
      path.join(bridgeRoot, "launcher", "PortableLauncher.cs"),
      generated,
    ], { cwd: temp });
    if (!fs.existsSync(built) || fs.statSync(built).size <= 0) throw new Error("PORTABLE_BUILD: empty exe");

    fs.mkdirSync(outDir, { recursive: true });
    const portableExe = path.join(outDir, "CopilotCC.exe");
    fs.copyFileSync(built, portableExe);
    if (fs.readdirSync(outDir).length !== 1) throw new Error("PORTABLE_BUILD: output is not single-file");
    return {
      portableExe,
      payloadHash,
      bytes: fs.statSync(portableExe).size,
      sha256: sha256(fs.readFileSync(portableExe)),
      zipBytes: fs.statSync(zip).size,
      storedBytes,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  buildPortableExe({
    sourceDir: path.join(bridgeRoot, "dist", "ccc-bridge-win-x64"),
    outDir: path.join(bridgeRoot, "dist", "portable-win-x64"),
  }).then((result) => {
    console.log(`PORTABLE_BUILD_OK=${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
