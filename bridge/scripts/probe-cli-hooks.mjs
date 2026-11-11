/** 真实 CLI Session Hooks 探针：隔离配置 + 本机假上游，不访问真实中转。 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERIFY_ROOT = "D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110";
const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 监听回环随机端口。
 * @param {http.RequestListener} handler 请求处理器
 * @returns {Promise<{server: http.Server, port: number}>} 服务与端口
 */
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOOPBACK_LISTEN_FAILED");
  return { server, port: address.port };
}

/**
 * 从 PATH 解析真实 CLI，Windows 优先 npm 包内的原生 exe。
 * @returns {string} 可执行文件路径
 */
function resolveCli() {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const first = result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : "";
  if (!first) throw new Error("CLI_NOT_FOUND");
  if (process.platform !== "win32") return first;
  const native = path.join(path.dirname(first), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (fs.existsSync(native)) return native;
  if (!first.toLowerCase().endsWith(".exe")) throw new Error("CLI_NATIVE_EXE_NOT_FOUND");
  return first;
}

/**
 * 为 command Hook 生成仅调用本仓库 helper 的 shell 命令。
 * @returns {string} 带引号的命令
 */
function helperCommand() {
  const tsx = path.join(bridgeRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const entry = path.join(bridgeRoot, "src", "index.ts");
  if (!fs.existsSync(tsx)) throw new Error("TSX_NOT_FOUND");
  const quote = (value) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(tsx)} ${quote(entry)} --terminal-hook`;
}

/**
 * 等长常量时间比较 Hook token。
 * @param {string} actual 请求值
 * @param {string} expected 私有预期值
 * @returns {boolean} 是否一致
 */
function sameToken(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const transport = process.argv.includes("--transport")
  ? process.argv[process.argv.indexOf("--transport") + 1]
  : "http";
if (transport !== "http" && transport !== "command") throw new Error("USAGE: --transport http|command");

fs.mkdirSync(VERIFY_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(VERIFY_ROOT, `probe-${transport}-`));
const configDir = path.join(root, "claude-config");
const workDir = path.join(root, "work");
const privateDir = path.join(root, "private");
for (const dir of [configDir, workDir, privateDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const leaseId = randomUUID();
const hookToken = randomBytes(32).toString("base64url");
let hookEvent = null;
let upstreamRequests = 0;
let notifyHook = () => {};
const hooked = new Promise((resolve) => { notifyHook = resolve; });

const upstream = await listen((req, res) => {
  upstreamRequests += 1;
  req.resume();
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { type: "probe", message: "intentional local rejection" } }));
});
const hookServer = await listen((req, res) => {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size <= 65_536) chunks.push(chunk);
  });
  req.on("end", () => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.method !== "POST" || req.url !== `/terminal-hook/${leaseId}` || !sameToken(token, hookToken) || size > 65_536) {
      res.writeHead(403).end("{}");
      return;
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value.hook_event_name === "SessionStart" && typeof value.session_id === "string") {
        hookEvent = { event: value.hook_event_name, sessionId: value.session_id, source: value.source };
        notifyHook();
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    } catch {
      res.writeHead(422).end("{}");
    }
  });
});

const hookUrl = `http://127.0.0.1:${hookServer.port}/terminal-hook/${leaseId}`;
const hook = transport === "http"
  ? { type: "http", url: hookUrl, headers: { Authorization: `Bearer ${hookToken}` }, timeout: 5 }
  : { type: "command", command: helperCommand(), timeout: 5 };
const settingsFile = path.join(privateDir, "settings.json");
fs.writeFileSync(settingsFile, JSON.stringify({
  hooks: { SessionStart: [{ hooks: [hook] }], SessionEnd: [{ hooks: [hook] }] },
}, null, 2), { encoding: "utf8", mode: 0o600 });

const cliPath = resolveCli();
const childEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
  ANTHROPIC_API_KEY: "probe",
  ANTHROPIC_AUTH_TOKEN: "probe",
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_TELEMETRY: "1",
  CCC_TERMINAL_HOOK_URL: hookUrl,
  CCC_TERMINAL_HOOK_TOKEN: hookToken,
};
for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete childEnv[key];

const child = spawn(cliPath, ["-p", "probe", "--settings", settingsFile], {
  cwd: workDir,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
child.stdout.resume();
const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
const spawnError = new Promise((_, reject) => child.once("error", reject));
const timeout = new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("HOOK_PROBE_TIMEOUT")), 10_000);
  timer.unref();
});

try {
  await Promise.race([hooked, spawnError, timeout]);
  if (!hookEvent) throw new Error("SESSION_START_NOT_RECEIVED");
  console.log(JSON.stringify({
    ok: true,
    transport,
    hookEvent,
    upstreamRequests,
    realApiCalled: false,
    artifactDir: root,
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    transport,
    error: error instanceof Error ? error.message : String(error),
    upstreamRequests,
    artifactDir: root,
  }));
  process.exitCode = 1;
} finally {
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  await Promise.all([
    new Promise((resolve) => upstream.server.close(resolve)),
    new Promise((resolve) => hookServer.server.close(resolve)),
  ]);
}
