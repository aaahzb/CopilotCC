/**
 * 双终端真实窗口验收专用假 CLI。
 * 仅使用 Node 内置模块：写隔离转录、执行 settings 中的本机 Hook，绝不导入 SDK 或访问模型 API。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

interface HookDefinition {
  type?: string;
  command?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface FakeSettings {
  hooks?: Record<string, Array<{ hooks?: HookDefinition[] }>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir || !path.isAbsolute(configDir)) throw new Error("FAKE_CLAUDE_CONFIG_REQUIRED");
const cwd = process.cwd();
const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"));
const eventLog = path.join(configDir, "fake-cli-events.jsonl");
fs.mkdirSync(projectDir, { recursive: true });

/**
 * 取命令行选项后的单个值。
 * @param name 完整选项名
 * @returns 选项值；不存在时返回 undefined
 */
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

/**
 * 只记录非敏感验收事件，不记录 token、环境或完整命令行。
 * @param kind 事件类别
 * @param detail 可公开的会话字段
 * @returns 无返回值
 */
function recordEvent(kind: string, detail: Record<string, unknown> = {}): void {
  fs.appendFileSync(eventLog, `${JSON.stringify({ kind, pid: process.pid, ...detail })}\n`, "utf8");
}

if (args.includes("--version")) {
  process.stdout.write("2.1.316 (CopilotCC isolated fake)\n");
  process.exit(0);
}

/**
 * 运行不访问 API、不依赖 Claude 参数的原生 PTY 行为夹具。
 * @returns 永不正常 resolve；EXIT 直接以 7 退出，异常 EOF 时 reject
 * @throws 输入在 EXIT 前关闭时抛出 FAKE_PTY_SMOKE_EOF
 */
async function runPtySmokeMode(): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const writeSize = (): void => {
      process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`);
    };
    writeSize();
    process.stdout.on("resize", writeSize);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      process.stdout.write(`TICK:${ticks}\r\n`);
    }, 100);
    const smokeInput = readline.createInterface({ input: process.stdin, terminal: true });
    let exiting = false;
    smokeInput.on("line", (raw) => {
      const line = raw.trim();
      if (line === "ECHO") process.stdout.write("中文输出:你好\r\n");
      if (line === "EXIT") {
        exiting = true;
        clearInterval(timer);
        process.exit(7);
      }
    });
    smokeInput.on("close", () => {
      clearInterval(timer);
      if (!exiting) reject(new Error("FAKE_PTY_SMOKE_EOF"));
    });
  });
}

if (process.env.CCC_PTY_SMOKE_MODE === "1") await runPtySmokeMode();

let sessionId = option("--resume") ?? option("--session-id") ?? randomUUID();
if (!UUID_RE.test(sessionId)) throw new Error("FAKE_SESSION_ID_INVALID");
const settingsValue = option("--settings");
const settings: FakeSettings = settingsValue
  ? JSON.parse(settingsValue.trimStart().startsWith("{")
    ? settingsValue
    : fs.readFileSync(settingsValue, "utf8")) as FakeSettings
  : {};

/**
 * 当前会话的隔离 JSONL 路径。
 * @returns 绝对转录路径
 */
function transcriptPath(): string {
  return path.join(projectDir, `${sessionId}.jsonl`);
}

/**
 * 追加一条真实 Claude 转录结构的 JSON 行。
 * @param entry 用户、助手或系统转录项
 * @returns 无返回值
 */
function appendEntry(entry: Record<string, unknown>): void {
  const value = {
    timestamp: new Date().toISOString(),
    ...entry,
    uuid: typeof entry.uuid === "string" ? entry.uuid : randomUUID(),
  };
  fs.appendFileSync(transcriptPath(), `${JSON.stringify(value)}\n`, "utf8");
}

/**
 * 追加一条仅供 DOM 验收定位的助手消息。
 * @param text 非敏感定位文本
 * @returns 无返回值
 */
function appendAssistant(text: string): void {
  appendEntry({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/**
 * 从 settings 取 SessionStart/SessionEnd 共用的 Hook 定义。
 * @param eventName Hook 事件名
 * @returns 第一个 Hook 定义；未配置时返回 null
 */
function hookFor(eventName: "SessionStart" | "SessionEnd"): HookDefinition | null {
  return settings.hooks?.[eventName]?.[0]?.hooks?.[0] ?? null;
}

/**
 * 通过 command helper 或直接回环 HTTP 发送一个严格 Hook 事件。
 * @param eventName SessionStart 或 SessionEnd
 * @param extra source/reason 枚举字段
 * @returns Hook 完成后的 Promise；失败时 reject，不向终端打印秘密
 */
async function sendHook(
  eventName: "SessionStart" | "SessionEnd",
  extra: { source: string } | { reason: string },
): Promise<void> {
  if (process.env.CCC_FAKE_CLI_DISABLE_HOOKS === "1") return;
  const hook = hookFor(eventName);
  const payload = JSON.stringify({
    hook_event_name: eventName,
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath(),
    ...extra,
  });
  if (hook?.type === "command" && hook.command) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(hook.command, {
        cwd, env: process.env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true, shell: true,
      });
      let helperStderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        if (helperStderr.length < 4096) helperStderr += String(chunk);
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("FAKE_HOOK_TIMEOUT"));
      }, 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          recordEvent("hook-helper-stderr", { eventName, sessionId, message: helperStderr.trim().slice(0, 1024) });
          reject(new Error("FAKE_HOOK_FAILED"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(payload);
    });
  } else {
    const url = hook?.type === "http" ? hook.url : process.env.CCC_TERMINAL_HOOK_URL;
    const token = hook?.headers?.Authorization ?? (process.env.CCC_TERMINAL_HOOK_TOKEN
      ? `Bearer ${process.env.CCC_TERMINAL_HOOK_TOKEN}` : "");
    if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+\/terminal-hook\//.test(url)) return;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("FAKE_HOOK_FAILED");
  }
  recordEvent("hook", { eventName, sessionId, ...extra });
}

/**
 * 在切换会话前写新转录，再按真实来源通知 SessionStart。
 * @param nextId 新会话 UUID
 * @param source startup/resume/clear/compact/fork 之一
 * @param marker 用于确认镜像归属的助手文本
 * @returns 切换和 Hook 完成后的 Promise
 */
async function switchSession(nextId: string, source: string, marker: string): Promise<void> {
  sessionId = nextId;
  appendAssistant(marker);
  await sendHook("SessionStart", { source });
}

appendAssistant("TERMINAL_SESSION_STARTED");
recordEvent("start", { sessionId, resume: args.some((arg) => arg === "--resume" || arg.startsWith("--resume=")),
  resumeArg: option("--resume") ?? null, sessionIdArg: option("--session-id") ?? null, cwd });
try {
  await sendHook("SessionStart", { source: option("--resume") ? "resume" : "startup" });
} catch (error) {
  recordEvent("hook-error", { eventName: "SessionStart", sessionId,
    message: error instanceof Error ? error.message : "UNKNOWN" });
  throw error;
}

const streamMode = option("--input-format") === "stream-json";
if (streamMode) {
  /** 输出最小 SDK 初始化；验收到无会话终端前可用环境变量延迟这一测试夹具事件。 */
  const writeInit = (): void => {
    process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  };
  const initDelayMs = Number(process.env.CCC_FAKE_CLI_DELAY_STREAM_INIT_MS ?? "0");
  if (Number.isFinite(initDelayMs) && initDelayMs > 0) setTimeout(writeInit, initDelayMs).unref();
  else writeInit();
}

const input = readline.createInterface({ input: process.stdin, terminal: !streamMode });
let explicitExit = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

/** 停止正常会话的连续输出，避免退出后仍有计时器持有进程。 @returns 无返回值 */
function stopNormalTicks(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

process.stdout.write(`\x1b]0;CopilotCC Terminal ${sessionId.slice(0, 8)}\x07`);
// 输出子进程实际收到的尺寸事件；验收必须先等它，再查询 /size，不能以客户端发送帧代替。
process.stdout.on("resize", () => {
  if (!streamMode) process.stdout.write(`RESIZE:${process.stdout.columns}x${process.stdout.rows}\n`);
});
if (!streamMode) process.stdout.write("CopilotCC isolated fake CLI; commands: /clear /resume <uuid> /fork /compact /fixture compact|task|tools exit\nccc-fake> ");

input.on("line", (raw) => {
  void (async (): Promise<void> => {
    const line = raw.trim();
    try {
      if (streamMode) {
        const message = JSON.parse(line) as {
          type?: string;
          request_id?: string;
          subtype?: string;
          message?: { role?: string; content?: unknown };
        };
        if (message.type === "control_request" && typeof message.request_id === "string") {
          process.stdout.write(`${JSON.stringify({
            type: "control_response",
            response: { subtype: "success", request_id: message.request_id, response: {} },
          })}\n`);
          return;
        }
        if (message.type === "user") {
          const content = message.message?.content;
          // SDK streaming-input 的正文是字符串；数组形式也收窄为文本块，不执行其中任何指令。
          const text = typeof content === "string" ? content : Array.isArray(content)
            ? content.flatMap((block) => typeof block === "object" && block !== null
              && "type" in block && block.type === "text" && "text" in block
              && typeof block.text === "string" ? [block.text] : []).join("")
            : "";
          if (!text) return;
          const reply = text === "NATIVE_FAILURE_CHAT_ACCEPTED"
            ? "NATIVE_FAILURE_CHAT_REPLY" : `FAKE_SDK_REPLY: ${text}`;
          appendEntry({ type: "user", message: { role: "user", content: text } });
          appendAssistant(reply);
          // 只记录固定验收标记；其他聊天正文不进入事件日志。
          if (text === "NATIVE_FAILURE_CHAT_ACCEPTED") {
            recordEvent("chat", { sessionId, marker: text });
          }
          process.stdout.write(`${JSON.stringify({ type: "stream_event", event: {
            type: "content_block_delta", delta: { type: "text_delta", text: reply },
          } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: sessionId })}\n`);
        }
        return;
      }
      if (line === "/ticks on") {
        stopNormalTicks();
        tickCount = 0;
        tickTimer = setInterval(() => {
          tickCount += 1;
          process.stdout.write(`TICK:${tickCount}\n`);
        }, 250);
      } else if (line === "/ticks off") {
        stopNormalTicks();
      } else if (line === "/size") {
        process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\n`);
      } else if (line === "exit") {
        stopNormalTicks();
        explicitExit = true;
        await sendHook("SessionEnd", { reason: "prompt_input_exit" });
        recordEvent("exit", { sessionId });
        input.close();
        return;
      } else if (line === "/clear") {
        await sendHook("SessionEnd", { reason: "clear" });
        await switchSession(randomUUID(), "clear", "TERMINAL_CLEAR_CONFIRMED");
      } else if (line.startsWith("/resume ")) {
        const nextId = line.slice("/resume ".length).trim();
        if (!UUID_RE.test(nextId)) throw new Error("FAKE_RESUME_UUID_REQUIRED");
        await sendHook("SessionEnd", { reason: "resume" });
        await switchSession(nextId, "resume", "TERMINAL_RESUME_CONFIRMED");
      } else if (line === "/fork") {
        await switchSession(randomUUID(), "fork", "TERMINAL_FORK_CONFIRMED");
      } else if (line === "/compact") {
        const summary = "INTERNAL_COMPACT_SUMMARY_COLLAPSED\n\n完整内部摘要，不冒充用户发言。";
        appendEntry({ type: "system", subtype: "compact_boundary", compactMetadata: {
          preTokens: 120000, postTokens: 6000, preservedSegment: { anchorUuid: "fixture-compact-summary" },
        } });
        appendEntry({ type: "user", uuid: "fixture-compact-summary", isCompactSummary: true,
          isVisibleInTranscriptOnly: true, message: { content: summary } });
        appendAssistant("TERMINAL_COMPACT_CONFIRMED");
        await sendHook("SessionStart", { source: "compact" });
      } else if (line === "/fixture compact") {
        appendEntry({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 9000, postTokens: 3000 } });
        appendEntry({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true,
          message: { content: "FIXTURE_COMPACT_FULL_DETAIL" } });
      } else if (line === "/fixture task") {
        const report = "SUBAGENT_REPORT_START\n\n完整子代理调查细节\n\nSUBAGENT_REPORT_END";
        const notification = `<task-notification>\n<task-id>task-fixture</task-id>\n<output-file>D:\\fixture.output</output-file>\n<status>completed</status>\n<summary>隔离任务报告</summary>\n<result>${report}</result>\n<usage><subagent_tokens>63</subagent_tokens></usage>\n</task-notification>`;
        appendEntry({ type: "user", turnOrigin: "task_notification",
          origin: { kind: "task-notification", producer: "session-task" }, message: { content: notification } });
      } else if (line === "/fixture tools") {
        const questions = [{ question: "选哪个？", header: "方案", options: [{ label: "A" }, { label: "B" }], multiSelect: false }];
        appendEntry({ type: "assistant", message: { content: [
          { type: "tool_use", id: "toolu-fixture-read", name: "Read", input: { file_path: "fixture.txt" } },
          { type: "tool_use", id: "toolu-fixture-edit", name: "Edit", input: { file_path: "fixture.txt", old_string: "旧行", new_string: "新行" } },
          { type: "tool_use", id: "toolu-fixture-ask", name: "AskUserQuestion", input: { questions } },
        ] } });
        appendEntry({ type: "user", toolUseResult: {
          filePath: "fixture.txt", oldString: "旧行", newString: "新行",
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-旧行", "+新行"] }],
        }, message: { content: [
          { type: "tool_result", tool_use_id: "toolu-fixture-read", content: "COMPLETE_TOOL_OUTPUT" },
          { type: "tool_result", tool_use_id: "toolu-fixture-edit", content: "文件已更新" },
          { type: "tool_result", tool_use_id: "toolu-fixture-ask", content: "answered" },
        ] } });
        // Ask 的真实 answers 位于 toolUseResult；与其他结果分开可避免一个条目只能携带一份元数据。
        appendEntry({ type: "user", toolUseResult: { questions, answers: { "选哪个？": "A" } },
          message: { content: [{ type: "tool_result", tool_use_id: "toolu-fixture-ask", content: "answered" }] } });
      } else if (line) {
        appendEntry({ type: "user", message: { content: line } });
        appendAssistant(`FAKE_ECHO: ${line}`);
        // 真实 CLI 的回复同时出现在终端与 JSONL；验收分别核对两条链路。
        process.stdout.write(`FAKE_ECHO: ${line}\n`);
      }
      process.stdout.write("ccc-fake> ");
    } catch {
      process.stdout.write("fake command failed\nccc-fake> ");
    }
  })();
});

input.on("close", () => {
  stopNormalTicks();
  process.exitCode = 0;
  if (streamMode || explicitExit) process.exit(0);
  // 某些 GUI/打包组合会先给假 CLI 一次 EOF；保持隔离进程供降级与窗口探针观察。
  recordEvent("stdin-eof", { sessionId });
  setInterval(() => {}, 1000);
});
