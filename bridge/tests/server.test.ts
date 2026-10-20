import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server";
import { slugifyPath } from "../src/transcript";
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

// ---- 会话管理：一个文件夹多会话（列表/新建/切换/删除） ----

/** 收集后续消息：inbox 为累计数组，waitFor(type, from) 只看下标 >= from 的消息（跳过同类旧消息） */
function collect(ws: WebSocket): { inbox: ServerMessage[]; waitFor: (type: string, from?: number, timeoutMs?: number) => Promise<ServerMessage> } {
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString()) as ServerMessage));
  const waitFor = (type: string, from = 0, timeoutMs = 3000): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const hit = inbox.slice(from).find((m) => m.type === type);
        if (hit) {
          clearInterval(timer);
          resolve(hit);
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待 ${type} 超时`));
        }
      }, 20);
    });
  return { inbox, waitFor };
}

describe("server 会话管理（一文件夹多会话）", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
    process.env.CCC_FAKE_HOME = fakeHome;
    // dir 由外层 beforeEach 建好；给它造两个会话转录
    const projDir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(dir)));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "sid-1.jsonl"), JSON.stringify({ type: "user", message: { content: "旧会话一" } }), "utf-8");
    fs.writeFileSync(path.join(projDir, "sid-2.jsonl"), JSON.stringify({ type: "user", message: { content: "旧会话二" } }), "utf-8");
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("folder.bind 后推送会话列表（两个历史会话，currentId=null）", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    const list = (await waitFor("session.list.data")) as Extract<ServerMessage, { type: "session.list.data" }>;
    expect(list.currentId).toBeNull();
    expect(list.sessions.map((s) => s.sessionId).sort()).toEqual(["sid-1", "sid-2"]);
    expect(list.sessions.find((s) => s.sessionId === "sid-1")?.title).toBe("旧会话一");
    ws.close();
    await server.close();
  });

  it("session.switch：resumed=true、工厂收到 resumeId、映射与 currentId 更新", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await waitFor("session.list.data");
    const n = inbox.length;
    ws.send(JSON.stringify({ type: "session.switch", sessionId: "sid-2" }));
    const bound = (await waitFor("folder.bound", n)) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ resumed: true, sessionId: "sid-2", title: "旧会话二" });
    const list = (await waitFor("session.list.data", n)) as Extract<ServerMessage, { type: "session.list.data" }>;
    expect(list.currentId).toBe("sid-2");
    expect(sentClientMessages.at(-1)?.opts.resumeId).toBe("sid-2");
    expect(sessions.get(dir)?.sessionId).toBe("sid-2");
    ws.close();
    await server.close();
  });

  it("session.new：清映射、回 folder.bound(resumed=false, sessionId=null)、工厂以无 resumeId 重建", async () => {
    sessions.set(dir, { sessionId: "sid-1", title: "旧会话一", updatedAt: "x" });
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await waitFor("session.list.data");
    const n = inbox.length;
    ws.send(JSON.stringify({ type: "session.new" }));
    const bound = (await waitFor("folder.bound", n)) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ resumed: false, sessionId: null });
    expect(sessions.get(dir)).toBeUndefined();
    expect(sentClientMessages.at(-1)?.opts.resumeId).toBeUndefined();
    const list = (await waitFor("session.list.data", n)) as Extract<ServerMessage, { type: "session.list.data" }>;
    expect(list.currentId).toBeNull();
    expect(list.sessions).toHaveLength(2); // 旧转录仍在列表里
    ws.close();
    await server.close();
  });

  it("session.delete：删当前会话回未开始态并删转录；删非当前只刷新列表", async () => {
    sessions.set(dir, { sessionId: "sid-1", title: "旧会话一", updatedAt: "x" });
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await waitFor("session.list.data");
    const projDir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(dir)));
    // 先删非当前会话 sid-2：文件消失、列表剩 1 个、不再发 folder.bound、映射不动
    let n = inbox.length;
    ws.send(JSON.stringify({ type: "session.delete", sessionId: "sid-2" }));
    const list = (await waitFor("session.list.data", n)) as Extract<ServerMessage, { type: "session.list.data" }>;
    expect(list.sessions.map((s) => s.sessionId)).toEqual(["sid-1"]);
    expect(fs.existsSync(path.join(projDir, "sid-2.jsonl"))).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(inbox.slice(n).some((m) => m.type === "folder.bound")).toBe(false);
    expect(sessions.get(dir)?.sessionId).toBe("sid-1");
    // 再删当前会话 sid-1：回未开始态
    n = inbox.length;
    ws.send(JSON.stringify({ type: "session.delete", sessionId: "sid-1" }));
    const bound = (await waitFor("folder.bound", n)) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ resumed: false, sessionId: null });
    expect(fs.existsSync(path.join(projDir, "sid-1.jsonl"))).toBe(false);
    expect(sessions.get(dir)).toBeUndefined();
    ws.close();
    await server.close();
  });
});
