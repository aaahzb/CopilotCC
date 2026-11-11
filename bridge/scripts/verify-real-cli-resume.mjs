/**
 * 真实 Claude Code CLI 会话恢复验收。
 * 使用真实 CLI 创建会话，再通过 --resume 续聊；本机假上游检查第二轮请求是否携带首轮上下文。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const APPROVED_ROOT = "D:\\ccc-fast-final-verify-20261026\\tool-history-20261027\\dual-terminal-20261110";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const CLI_TIMEOUT_MS = 60_000;

/**
 * 解析命令行中的命名参数。
 * @param {string} name 参数名
 * @returns {string | undefined} 参数值
 */
function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * 从 PATH 解析真实 CLI，Windows 优先 npm 包内的原生 exe。
 * @returns {string} CLI 绝对路径
 * @throws {Error} 找不到 CLI 或原生 exe 时抛出
 */
function resolveCli() {
  if (process.env.CLAUDE_CODE_REAL_CLI_PATH) return process.env.CLAUDE_CODE_REAL_CLI_PATH;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const first = result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : "";
  if (!first) throw new Error("CLI_NOT_FOUND");
  if (process.platform !== "win32") return first;
  const native = path.join(
    path.dirname(first), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe",
  );
  if (fs.existsSync(native)) return native;
  if (!first.toLowerCase().endsWith(".exe")) throw new Error("CLI_NATIVE_EXE_NOT_FOUND");
  return first;
}

/**
 * 将工作目录转换为 Claude 项目目录名。
 * @param {string} value 工作目录
 * @returns {string} 项目 slug
 */
function slugifyPath(value) {
  return path.resolve(value).replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * 启动仅监听回环地址的假上游。
 * @param {(body: any) => string} chooseReply 根据请求选择固定回复
 * @param {Array<Record<string, unknown>>} requests 脱敏请求证据
 * @returns {Promise<{server: http.Server, port: number}>} 服务与端口
 */
async function startUpstream(chooseReply, requests) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method !== "POST" || requestPath !== "/v1/messages" || size > MAX_REQUEST_BYTES) {
        requests.push({ kind: "rejected", method: req.method, url: req.url });
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "local probe only" } }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const reply = chooseReply(body);
        const serialized = JSON.stringify(body);
        requests.push({
          kind: "messages",
          stream: body.stream === true,
          messageCount: Array.isArray(body.messages) ? body.messages.length : null,
          serialized,
        });
        const model = typeof body.model === "string" ? body.model : "claude-opus-5-5";
        const message = {
          id: `msg_local_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: reply }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        };
        if (body.stream !== true) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(message));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const events = [
          ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        for (const [event, data] of events) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      } catch {
        requests.push({ kind: "invalid-json" });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "invalid local probe request" } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOOPBACK_LISTEN_FAILED");
  return { server, port: address.port };
}

/**
 * 运行真实 CLI 并等待退出。
 * @param {string} cliPath CLI 绝对路径
 * @param {string[]} args CLI 参数
 * @param {string} cwd 隔离工作目录
 * @param {NodeJS.ProcessEnv} env 隔离环境
 * @returns {Promise<{code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean}>} 退出与输出
 */
async function runCli(cliPath, args, cwd, env) {
  const child = spawn(cliPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-131_072); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, CLI_TIMEOUT_MS);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr, timedOut }));
    });
  } finally {
    clearTimeout(timer);
  }
}

const rootArg = option("root");
if (!rootArg) throw new Error("USAGE: --root <new-empty-approved-directory>");
const root = path.resolve(rootArg);
if (!root.startsWith(`${APPROVED_ROOT}\\`) && !root.startsWith(`${APPROVED_ROOT}/`)) {
  throw new Error("ROOT_OUTSIDE_APPROVED_DIRECTORY");
}
fs.mkdirSync(root, { recursive: false });
const configDir = path.join(root, "claude-config");
const workDir = path.join(root, "work");
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });

const runId = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
const sessionId = randomUUID();
const originalUser = `CC_RESUME_ORIGINAL_USER_${runId}`;
const originalAssistant = `CC_RESUME_ORIGINAL_ASSISTANT_${runId}`;
const resumeUser = `CC_RESUME_SECOND_USER_${runId}`;
const resumeAssistant = `CC_RESUME_SECOND_ASSISTANT_${runId}`;
const requests = [];
const upstream = await startUpstream((body) => {
  const serialized = JSON.stringify(body);
  if (serialized.includes(resumeUser)) return resumeAssistant;
  if (serialized.includes(originalUser)) return originalAssistant;
  return "CC_RESUME_UNEXPECTED_PROMPT";
}, requests);

const cliPath = resolveCli();
const version = spawnSync(cliPath, ["--version"], { encoding: "utf8", windowsHide: true });
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
  ANTHROPIC_API_KEY: "mock-local-only",
  ANTHROPIC_AUTH_TOKEN: "mock-local-only",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_TELEMETRY: "1",
};
// 非交互补验也不能继承当前 Claude Code 的子会话标记，保持与独立 CLI 一致。
delete env.CLAUDE_CODE_CHILD_SESSION;
for (const key of [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]) delete env[key];

let evidence;
try {
  const initial = await runCli(cliPath, [
    "--session-id", sessionId, "-p", originalUser, "--output-format", "json",
  ], workDir, env);
  const transcript = path.join(configDir, "projects", slugifyPath(workDir), `${sessionId}.jsonl`);
  const initialTranscript = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8") : "";
  const resumed = await runCli(cliPath, [
    "--resume", sessionId, "-p", resumeUser, "--output-format", "json",
  ], workDir, env);
  const finalTranscript = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8") : "";
  const sanitizedRequests = requests.map((request) => ({
    kind: request.kind,
    method: request.method,
    url: request.url,
    stream: request.stream,
    messageCount: request.messageCount,
    hasOriginalUser: typeof request.serialized === "string" && request.serialized.includes(originalUser),
    hasOriginalAssistant: typeof request.serialized === "string" && request.serialized.includes(originalAssistant),
    hasResumeUser: typeof request.serialized === "string" && request.serialized.includes(resumeUser),
  }));
  const resumeRequest = sanitizedRequests.find((request) => request.hasResumeUser);
  const checks = {
    initialExitZero: initial.code === 0 && !initial.timedOut,
    initialReplyReceived: initial.stdout.includes(originalAssistant),
    originalTranscriptCreated: initialTranscript.includes(originalUser) && initialTranscript.includes(originalAssistant),
    resumedExitZero: resumed.code === 0 && !resumed.timedOut,
    resumedReplyReceived: resumed.stdout.includes(resumeAssistant),
    resumeRequestSeen: Boolean(resumeRequest),
    originalUserIncludedInResume: resumeRequest?.hasOriginalUser === true,
    originalAssistantIncludedInResume: resumeRequest?.hasOriginalAssistant === true,
    sameTranscriptContainsBothTurns: [originalUser, originalAssistant, resumeUser, resumeAssistant]
      .every((marker) => finalTranscript.includes(marker)),
  };
  evidence = {
    ok: Object.values(checks).every(Boolean),
    checks,
    cliVersion: version.status === 0 ? version.stdout.trim() : "unknown",
    sessionId,
    requests: sanitizedRequests,
    failures: {
      initial: initial.code === 0 ? null : { code: initial.code, signal: initial.signal, timedOut: initial.timedOut, stdout: initial.stdout.slice(-4000), stderr: initial.stderr.slice(-4000) },
      resumed: resumed.code === 0 ? null : { code: resumed.code, signal: resumed.signal, timedOut: resumed.timedOut, stdout: resumed.stdout.slice(-4000), stderr: resumed.stderr.slice(-4000) },
    },
    upstreamOrigin: "http://127.0.0.1",
    realApiCalled: false,
    artifactDir: root,
  };
  fs.writeFileSync(path.join(root, "real-cli-resume.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  await new Promise((resolve) => upstream.server.close(resolve));
}
