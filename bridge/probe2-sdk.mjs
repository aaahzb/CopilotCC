// 探针 2：完全复刻 bridge 的发送策略 —— 先等 init，拿到 session_id 后才发第一条
// 若 init 在无输入时不来 → 证实 bridge 死锁；顺带验证 canUseTool 常挂是否影响
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-probe2-"));
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const inbox = [];
let wake = null;
async function* userStream() {
  while (true) {
    if (inbox.length > 0) { yield inbox.shift(); continue; }
    await new Promise((r) => (wake = r));
    wake = null;
  }
}

const q = query({
  prompt: userStream(),
  options: {
    cwd,
    permissionMode: "auto",
    includePartialMessages: true,
    canUseTool: async (tool, input) => {
      log(">>> canUseTool 被调用:", tool);
      return { behavior: "allow", updatedInput: input };
    },
    stderr: (l) => log("[stderr]", l.slice(0, 200)),
  },
});

let gotInit = false;
(async () => {
  try {
    for await (const m of q) {
      const tag = m.type + (m.subtype ? "/" + m.subtype : "");
      if (!JSON.stringify(m).includes("thinking")) log("MSG", tag, JSON.stringify(m).slice(0, 140));
      if (m.type === "system" && m.subtype === "init" && !gotInit) {
        gotInit = true;
        log(">>> 收到 init（此刻未发送过任何输入）—— 模拟 bridge 现在才发第一条");
        inbox.push({ type: "user", message: { role: "user", content: "只回复这四个字: bridge-ok" }, parent_tool_use_id: null, session_id: m.session_id });
        wake?.();
      }
      if (m.type === "result") { log(">>> result 到达，探针2 通过"); process.exit(0); }
    }
    log("流结束但未见 result");
    process.exit(1);
  } catch (e) {
    log("!! 异常:", e?.message ?? String(e));
    process.exit(1);
  }
})();

// 12 秒未见 init 就判定：init 需要输入触发（死锁实锤），改用空 session_id 立即发
setTimeout(() => {
  if (!gotInit) {
    log(">>> 12s 未收到 init —— 证实死锁假设。立即用 session_id=\"\" 发送");
    inbox.push({ type: "user", message: { role: "user", content: "只回复这四个字: bridge-ok" }, parent_tool_use_id: null, session_id: "" });
    wake?.();
  }
}, 12_000);
setTimeout(() => { log("!! 150s 总超时"); process.exit(2); }, 150_000);
