import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server";
import { SessionManager } from "../src/session-manager";
import type { BridgeConfig } from "../src/config";
import type { ServerMessage } from "../src/protocol";

let dir: string;
let sessions: SessionManager;
let sentClientMessages: Array<{ cwd: string; opts: Record<string, unknown> }>;
let fakeHandle: { send: (t: string) => void; abort: () => void; respondPermission: (id: string, a: boolean) => void; close: () => Promise<void> };

/** 构造测试配置，默认端口 0（系统分配） */
function makeConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return { token: "tok", port: 0, allowedOrigins: [], createdAt: "", ...over };
}

/** 启动服务并返回连接 URL */
async function boot(config: BridgeConfig) {
  const server = startServer({
    config,
    sessions,
    createSession: ((cwd: string, opts: Record<string, unknown>) => {
      sentClientMessages.push({ cwd, opts });
      return fakeHandle;
    }) as never,
  });
  await new Promise((r) => server.wss.on("listening", r));
  const port = (server.wss.address() as AddressInfo).port;
  return { server, url: `ws://127.0.0.1:${port}/ws` };
}

/** 连接并收第一条消息 */
function connect(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; first: ServerMessage }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=tok`, { headers });
    ws.once("message", (d) => resolve({ ws, first: JSON.parse(d.toString()) }));
    ws.once("error", reject);
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
  sessions = new SessionManager(path.join(dir, "sessions.json"));
  sentClientMessages = [];
  fakeHandle = {
    send: (t) => {
      sentClientMessages.push({ cwd: "SEND", opts: { text: t } });
    },
    abort: () => {},
    respondPermission: () => {},
    close: async () => {},
  };
});

describe("server 安全校验", () => {
  it("正确 token + 无白名单 → auth.ok", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws, first } = await connect(url);
    expect(first.type).toBe("auth.ok");
    ws.close();
    await server.close();
  });

  it("错误 token → auth.fail", async () => {
    const { server, url } = await boot(makeConfig());
    const ws = new WebSocket(`${url}?token=wrong`);
    const msg = await new Promise<ServerMessage>((r) => ws.once("message", (d) => r(JSON.parse(d.toString()))));
    expect(msg.type).toBe("auth.fail");
    await server.close();
  });

  it("白名单外 Origin 收到 auth.fail，白名单内放行", async () => {
    const good = "chrome-extension://abcdefgh";
    const { server, url } = await boot(makeConfig({ allowedOrigins: [good] }));
    // 服务端会先发 auth.fail 说明原因再关闭，所以连接能建立但首条消息是 auth.fail
    const bad = await connect(url, { origin: "https://evil.com" });
    expect(bad.first.type).toBe("auth.fail");
    bad.ws.close();
    const { ws, first } = await connect(url, { origin: good });
    expect(first.type).toBe("auth.ok");
    ws.close();
    await server.close();
  });
});

describe("server 消息路由", () => {
  it("folder.bind 无效路径 → folder.error", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    ws.send(JSON.stringify({ type: "folder.bind", path: path.join(dir, "nope") }));
    const msg = await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    expect(msg.type).toBe("folder.error");
    ws.close();
    await server.close();
  });

  it("folder.bind 有效路径 → folder.bound（resumed=false）并创建会话；chat.send 转发到会话", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    const bound = await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    expect(bound).toMatchObject({ type: "folder.bound", resumed: false });
    ws.send(JSON.stringify({ type: "chat.send", text: "你好" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(sentClientMessages.some((m) => m.cwd === "SEND" && (m.opts as { text: string }).text === "你好")).toBe(true);
    ws.close();
    await server.close();
  });

  it("老文件夹命中映射 → resumed=true", async () => {
    sessions.set(dir, { sessionId: "sid-old", title: "旧会话", updatedAt: "x" });
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    const bound = await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    expect(bound).toMatchObject({ type: "folder.bound", resumed: true, sessionId: "sid-old", title: "旧会话" });
    ws.close();
    await server.close();
  });
});
