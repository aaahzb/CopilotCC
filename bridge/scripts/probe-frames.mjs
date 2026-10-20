// 诊断探针：跑一次真实 SDK query（plan 模式，不碰文件），逐帧打印 type/subtype 与 model/effort 字段出现位置
// 用法：node bridge/scripts/probe-frames.mjs（脚本内模块解析相对自身路径，任意 cwd 可跑）
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "只回复一个字：好",
  options: { cwd: process.cwd(), permissionMode: "plan" },
});

for await (const msg of q) {
  const m = msg;
  const head = `${m.type}${m.subtype ? "/" + m.subtype : ""}`;
  if (m.type === "system" && m.subtype === "init") {
    console.log(head, "| model=", m.model, "| effort=", JSON.stringify(m.effort ?? "<缺字段>"));
  } else if (m.type === "assistant") {
    const mm = m.message ?? {};
    console.log(head, "| msg.model=", mm.model, "| msg.effort=", JSON.stringify(mm.effort ?? "<无>"));
  } else if (m.type === "result") {
    console.log(head, "| modelUsage=", JSON.stringify(m.modelUsage));
  } else if (m.type !== "system") {
    console.log(head);
  }
}
console.log("PROBE DONE");
