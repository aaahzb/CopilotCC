// 探针：直接调 Agent SDK，逐条打印消息与 stderr，定位 selftest:live 超时根因
// 用法: node probe-sdk.mjs [permissionMode]   （默认 acceptEdits）
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mode = process.argv[2] ?? "acceptEdits";
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-probe-"));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

log("开始, permissionMode =", mode, "cwd =", cwd);

async function* userStream() {
  log("generator: SDK 开始拉取输入");
  // 立即发第一条（session_id 空串 = 新会话），不等 init —— 用来验证 init 到底何时到达
  yield { type: "user", message: { role: "user", content: "只回复这四个字: bridge-ok" }, parent_tool_use_id: null, session_id: "" };
  log("generator: 第一条已 yield，流保持打开");
  await new Promise(() => {}); // 常驻流，进程退出时自然结束
}

const q = query({
  prompt: userStream(),
  options: {
    cwd,
    permissionMode: mode,
    includePartialMessages: true,
    stderr: (line) => log("[stderr]", line.slice(0, 300)),
  },
});

const timer = setTimeout(() => { log("!! 120s 超时，主动退出"); process.exit(2); }, 120_000);

try {
  for await (const m of q) {
    const tag = m.type + (m.subtype ? "/" + m.subtype : "");
    log("MSG", tag, JSON.stringify(m).slice(0, 180));
    if (m.type === "result") break;
  }
  log("流正常结束");
} catch (e) {
  log("!! 异常:", e?.message ?? String(e));
  process.exit(1);
} finally {
  clearTimeout(timer);
}
process.exit(0);
