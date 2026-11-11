/** 真实 CLI 验收夹具：PATH 解析、隔离进程运行和仅回环的 Anthropic 消息假上游。 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * 从 PATH 解析真实 Claude Code CLI。
 * @returns {string} Windows 原生 exe 或其他平台的 CLI 绝对路径
 * @throws {Error} 找不到真实 CLI 时抛出
 */
export function resolveRealCli() {
  if (process.env.CLAUDE_CODE_REAL_CLI_PATH) return process.env.CLAUDE_CODE_REAL_CLI_PATH;
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["claude"], {
    encoding: "utf8", windowsHide: true,
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
 * 启动假上游；只在内存中保存固定标记的布尔证据，不保存请求头、密钥或正文。
 * @param {Record<string, string>} markers 各阶段用户/助手固定标记
 * @returns {Promise<{server: http.Server, port: number, requests: Array<Record<string, unknown>>}>} 本地服务
 */
export async function startRealCliUpstream(markers) {
  const requests = [];
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
        requests.push({ kind: "rejected", method: req.method, path: requestPath });
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "local probe only" } }));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const serialized = JSON.stringify(body);
        // resume 请求的历史也包含上一轮标记；阶段只能由最新用户消息决定。
        const latestUser = Array.isArray(body.messages)
          ? [...body.messages].reverse().find((message) => message?.role === "user") : null;
        const latestUserSerialized = JSON.stringify(latestUser ?? {});
        const stage = latestUserSerialized.includes(markers.systemUser) ? "system"
          : latestUserSerialized.includes(markers.embeddedUser) ? "embedded"
            : latestUserSerialized.includes(markers.initialUser) ? "initial" : "unexpected";
        const reply = stage === "embedded" ? markers.embeddedAssistant
          : stage === "system" ? markers.systemAssistant
            : stage === "initial" ? markers.initialAssistant : "REAL_CLI_UNEXPECTED_PROMPT";
        requests.push({
          kind: "messages",
          stage,
          stream: body.stream === true,
          messageCount: Array.isArray(body.messages) ? body.messages.length : null,
          hasOriginalUser: serialized.includes(markers.initialUser),
          hasOriginalAssistant: serialized.includes(markers.initialAssistant),
          hasEmbeddedUser: serialized.includes(markers.embeddedUser),
          hasSystemUser: serialized.includes(markers.systemUser),
        });
        const model = typeof body.model === "string" ? body.model : "claude-opus-5-5";
        const message = {
          id: `msg_local_${randomUUID()}`, type: "message", role: "assistant", model,
          content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        };
        if (body.stream !== true) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(message));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
        });
        const events = [
          ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
  return { server, port: address.port, requests };
}

/**
 * 运行真实 CLI 的非交互验收步骤。
 * @param {string} cliPath 真实 CLI 路径
 * @param {string[]} args CLI 参数
 * @param {string} cwd 隔离工作目录
 * @param {NodeJS.ProcessEnv} env 隔离环境
 * @param {number} timeoutMs 超时毫秒
 * @returns {Promise<{code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean}>} 运行结果
 */
export async function runRealCli(cliPath, args, cwd, env, timeoutMs = 60_000) {
  const child = spawn(cliPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-131_072); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr, timedOut }));
    });
  } finally {
    clearTimeout(timer);
  }
}
