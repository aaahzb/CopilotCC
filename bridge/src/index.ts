/** ccc-bridge CLI 入口：start（默认）/ selftest [--live] / --print-token */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { loadOrCreateConfig, configDir } from "./config";
import { SessionManager } from "./session-manager";
import { startServer } from "./server";
import { type ServerMessage } from "./protocol";

const cmd = process.argv[2] ?? "start";

/** 打印配对信息并启动常驻服务 */
function cmdStart(): void {
  const config = loadOrCreateConfig();
  const sessions = new SessionManager(path.join(configDir(), "sessions.json"));
  sessions.load();
  startServer({ config, sessions });
  console.log(`[ccc-bridge] 已启动 ws://127.0.0.1:${config.port}/ws`);
  console.log(`[ccc-bridge] 配对 token: ${config.token}`);
  console.log(`[ccc-bridge] 配置目录: ${configDir()}（config.json 里可配 allowedOrigins）`);
}

/** 等待某类型消息到达 */
function makeWaiter(ws: WebSocket, inbox: ServerMessage[]): (type: string, timeoutMs?: number) => Promise<ServerMessage> {
  return (type: string, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find((m) => m.type === type);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
      ws.on("message", function onMsg(d) {
        const m = JSON.parse(d.toString()) as ServerMessage;
        if (m.type === type) {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
}

/**
 * 自检：临时配置起服务 → 假客户端走完整握手与绑定流程。
 * --live 时额外向真实 claude 发一条消息并等待 chat.done（消耗一次 API 调用）。
 * @param live 是否调用真实 claude
 */
async function cmdSelftest(live: boolean): Promise<void> {
  process.env.CCC_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-selftest-"));
  const config = loadOrCreateConfig();
  config.port = 0;
  const sessions = new SessionManager(path.join(configDir(), "sessions.json"));
  const server = startServer({ config, sessions });
  await new Promise((r) => server.wss.on("listening", r));
  const port = (server.wss.address() as AddressInfo).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${config.token}`);
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString()) as ServerMessage;
      inbox.push(m);
      if (live) console.log("  <==", JSON.stringify(m).slice(0, 140));
    } catch {
      // 忽略坏帧
    }
  });
  const waitFor = makeWaiter(ws, inbox);
  await new Promise<void>((r) => ws.on("open", () => r()));

  const auth = await waitFor("auth.ok");
  console.log("✓ 握手认证", auth.type);

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-notes-"));
  ws.send(JSON.stringify({ type: "folder.bind", path: folder }));
  const bound = await waitFor("folder.bound");
  console.log("✓ 文件夹绑定", JSON.stringify(bound));

  if (live) {
    console.log("… 正在向真实 claude 发送测试消息（走你本机的中转配置）");
    ws.send(JSON.stringify({ type: "chat.send", text: "只回复这四个字: bridge-ok" }));
    // chat.error 到达即失败，不再傻等超时把真实错误吞掉
    await Promise.race([
      waitFor("chat.done", 120_000),
      waitFor("chat.error", 120_000).then((m) => {
        throw new Error(`收到 chat.error: ${JSON.stringify(m)}`);
      }),
    ]);
    const sid = sessions.get(folder)?.sessionId;
    if (!sid) throw new Error("未拿到 sessionId");
    console.log("✓ 真实会话完成，sessionId =", sid);
    console.log("✓ live 自检全部通过");
  } else {
    console.log("✓ 离线自检通过（未调用真实 claude；加 --live 做端到端验证）");
  }
  ws.close();
  await server.close();
  process.exit(0);
}

if (cmd === "start") {
  cmdStart();
} else if (cmd === "selftest") {
  cmdSelftest(process.argv.includes("--live")).catch((e) => {
    console.error("自检失败:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else if (cmd === "--print-token") {
  console.log(loadOrCreateConfig().token);
} else {
  console.error("用法: tsx src/index.ts [start|selftest [--live]|--print-token]");
  process.exit(1);
}
