import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { startServer, type ServerDeps } from "../src/server";
import { decodePairing } from "../src/pairing";
import { slugifyPath } from "../src/transcript";
import { SessionManager } from "../src/session-manager";
import { AliasManager } from "../src/alias-manager";
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

/** 启动服务并返回连接 URL；extra 可传 configDir 等附加依赖（在线改端口测试用） */
async function boot(config: BridgeConfig, extra: Partial<ServerDeps> = {}) {
  const server = await startServer({
    config,
    sessions,
    createSession: ((cwd: string, opts: Record<string, unknown>) => {
      sentClientMessages.push({ cwd, opts });
      return fakeHandle;
    }) as never,
    ...extra,
  });
  return { server, url: `ws://127.0.0.1:${server.port}/ws` };
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

  it("白名单非空时，无 Origin 头的本机进程（selftest/CLI）放行", async () => {
    const { server, url } = await boot(makeConfig({ allowedOrigins: ["chrome-extension://abcdefgh"] }));
    // 浏览器 WebSocket 必发 Origin 头；无头 = 非浏览器本机进程，白名单不该误杀
    const { ws, first } = await connect(url);
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

  it("createSession 同步抛异常 → chat.error 且桥接存活（WS 不断、后续消息正常）", async () => {
    // v2026.10.21.7 秒断事故回归：SDK 初始化同步抛错曾沿消息处理器冒泡打崩整个进程
    const { server, url } = await boot(makeConfig(), {
      createSession: (() => {
        throw new Error("boom-测试异常");
      }) as never,
    });
    const { ws } = await connect(url);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    const err = await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    expect(err.type).toBe("chat.error");
    expect(err.type === "chat.error" && err.message).toContain("boom-测试异常");
    // 进程与连接都活着：再发一条消息仍能得到正常响应
    ws.send(JSON.stringify({ type: "folder.bind", path: path.join(dir, "nope") }));
    const alive = await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    expect(alive.type).toBe("folder.error");
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

  it("chat.send 携带 uploads：文件落盘 copilotUploads，会话收到说明块+客户端原文", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    const dataB64 = Buffer.from("hello 上传", "utf-8").toString("base64");
    ws.send(JSON.stringify({ type: "chat.send", text: "[用户问题]\n看看", uploads: [{ name: "note.txt", dataB64 }] }));
    await new Promise((r) => setTimeout(r, 50)); // 落盘与转发都在处理器内同步完成，稍等即可
    const saved = path.join(dir, "copilotUploads", "note.txt");
    expect(fs.readFileSync(saved, "utf-8")).toBe("hello 上传");
    const sent = sentClientMessages.find((m) => m.cwd === "SEND");
    expect(sent).toBeTruthy();
    const t = (sent!.opts as { text: string }).text;
    expect(t.startsWith("[上传文件]")).toBe(true); // 说明块拼在最前（含落盘真实路径）
    expect(t).toContain(saved);
    expect(t).toContain("[用户问题]\n看看"); // 客户端原文原样在后
    ws.close();
    await server.close();
  });

  it("uploads 全部保存失败 → chat.error 逐条上报且不转发会话", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ type: "chat.send", text: "[用户问题]\n看看", uploads: [{ name: "bad.txt", dataB64: "!!!" }] }));
    const err = await new Promise<ServerMessage>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    expect(err.type).toBe("chat.error");
    expect(err.type === "chat.error" && err.message).toContain("bad.txt");
    await new Promise((r) => setTimeout(r, 30));
    expect(sentClientMessages.some((m) => m.cwd === "SEND")).toBe(false);
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

describe("端口占用处理", () => {
  it("同 token 的第二个实例被拒绝（duplicate 探测）", async () => {
    const a = await boot(makeConfig());
    await expect(startServer({ config: makeConfig({ port: a.server.port }), sessions })).rejects.toThrow(/另一个 ccc-bridge 实例/);
    await a.server.close();
  });

  it("被无关程序占用时顺延到下一可用端口", async () => {
    // 占用者：收连接但永不回应（模拟无关的本地服务）；跟踪其 socket 便于清理
    const socks = new Set<net.Socket>();
    const block = net.createServer((s) => {
      socks.add(s);
      s.on("close", () => socks.delete(s));
      s.on("error", () => {});
    });
    await new Promise<void>((r) => block.listen(0, "127.0.0.1", () => r()));
    const taken = (block.address() as net.AddressInfo).port;
    const server = await startServer({ config: makeConfig({ port: taken }), sessions });
    try {
      expect(server.port).toBeGreaterThan(taken);
      const { ws, first } = await connect(`ws://127.0.0.1:${server.port}/ws`);
      expect(first.type).toBe("auth.ok");
      ws.close();
    } finally {
      await server.close();
      for (const s of socks) s.destroy(); // 防御：即使探测连接泄漏也不让 close 干等
      await new Promise<void>((r) => block.close(() => r()));
    }
  });
});

describe("在线改端口（/config 设置页）", () => {
  it("GET：无 token 403、带 token 返回设置页、其他路径 404", async () => {
    const { server } = await boot(makeConfig(), { configDir: dir });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/config`)).status).toBe(403);
    const page = await fetch(`${base}/config?t=tok`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("修改端口");
    expect((await fetch(`${base}/other?t=tok`)).status).toBe(404);
    await server.close();
  });

  it("POST：鉴权/校验拒绝不动现状；成功后新端口可连、config.json 写回、旧端口关闭、返回配对串", async () => {
    const { server } = await boot(makeConfig(), { configDir: dir });
    const oldPort = server.port;
    // 先借一个系统分配的空闲端口当目标（用完即放，降低撞车概率）
    const probeSrv = net.createServer();
    await new Promise<void>((r) => probeSrv.listen(0, "127.0.0.1", () => r()));
    const target = (probeSrv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probeSrv.close(() => r()));

    const post = (port: number, body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await post(oldPort, { t: "wrong", p: target })).status).toBe(403); // token 错
    expect((await post(oldPort, { t: "tok", p: 80 })).status).toBe(400); // 端口非法
    expect(server.port).toBe(oldPort); // 被拒绝的请求不影响现状

    const res = await post(oldPort, { t: "tok", p: target });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; port: number; pairing: string };
    expect(data.ok).toBe(true);
    expect(data.port).toBe(target);
    expect(decodePairing(data.pairing)).toEqual({ h: "127.0.0.1", p: target, t: "tok" });
    expect(server.port).toBe(target); // StartedServer.port 跟随在线切换
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8")) as BridgeConfig;
    expect(saved.port).toBe(target); // 新端口已写回 config.json

    // 新端口握手正常
    const { ws, first } = await connect(`ws://127.0.0.1:${target}/ws`);
    expect(first.type).toBe("auth.ok");
    ws.close();

    // 旧端口在切换后 ~250ms 拆除：轮询等它拒连
    let refused = false;
    for (let i = 0; i < 30 && !refused; i++) {
      refused = await new Promise<boolean>((resolve) => {
        const s = net.connect(oldPort, "127.0.0.1");
        s.once("connect", () => {
          s.destroy();
          resolve(false);
        });
        s.once("error", () => resolve(true));
      });
      if (!refused) await new Promise((r) => setTimeout(r, 100));
    }
    expect(refused).toBe(true);
    await server.close();
  }, 15000);

  it("setPort（托盘弹窗路径）：直接在线切换并持久化，无需 HTTP", async () => {
    const { server } = await boot(makeConfig(), { configDir: dir });
    // 借系统分配拿一个空闲端口当目标（用完即放）
    const probeSrv = net.createServer();
    await new Promise<void>((r) => probeSrv.listen(0, "127.0.0.1", () => r()));
    const target = (probeSrv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probeSrv.close(() => r()));

    const port = await server.setPort(target);
    expect(port).toBe(target);
    expect(server.port).toBe(target); // getter 跟随
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8")) as BridgeConfig;
    expect(saved.port).toBe(target); // 已持久化
    const { ws, first } = await connect(`ws://127.0.0.1:${target}/ws`);
    expect(first.type).toBe("auth.ok");
    ws.close();
    await server.close();
  });
});

// ---- 别名：文件夹+会话的命名组合（alias.* + folder.pick） ----

describe("别名（alias.* + folder.pick）", () => {
  let fakeHome: string;
  let aliases: AliasManager;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
    process.env.CCC_FAKE_HOME = fakeHome;
    aliases = new AliasManager(path.join(dir, "aliases.json"));
    // 造一个历史会话转录（sid-1），供续聊路径匹配
    const projDir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(dir)));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "sid-1.jsonl"), JSON.stringify({ type: "user", message: { content: "旧会话一" } }), "utf-8");
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("alias.create（新会话）：立即绑定、列表推送、成为当前别名", async () => {
    const { server, url } = await boot(makeConfig(), { aliases });
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.create", name: "笔记", folder: dir, sessionId: null }));
    const bound = (await waitFor("folder.bound")) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ path: dir, resumed: false, sessionId: null });
    const list = (await waitFor("alias.list.data")) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(list.aliases).toHaveLength(1);
    expect(list.aliases[0]).toMatchObject({ name: "笔记", folder: dir, sessionId: null });
    expect(list.currentId).toBe(list.aliases[0].id);
    ws.close();
    await server.close();
  });

  it("alias.select：指向已存在会话 → resumed=true；指向已删会话 → 退回新会话并修正别名", async () => {
    aliases.create("旧", dir, "sid-1");
    aliases.create("鬼", dir, "ghost-sid"); // 转录里不存在
    const { server, url } = await boot(makeConfig(), { aliases });
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.list" }));
    const l0 = (await waitFor("alias.list.data")) as Extract<ServerMessage, { type: "alias.list.data" }>;
    const ghostId = l0.aliases.find((a) => a.name === "鬼")!.id;
    let n = inbox.length;
    ws.send(JSON.stringify({ type: "alias.select", id: l0.aliases[0].id }));
    const bound = (await waitFor("folder.bound", n)) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ resumed: true, sessionId: "sid-1", title: "旧会话一" });
    expect(sentClientMessages.at(-1)?.opts.resumeId).toBe("sid-1");
    n = inbox.length;
    ws.send(JSON.stringify({ type: "alias.select", id: ghostId }));
    const bound2 = (await waitFor("folder.bound", n)) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound2).toMatchObject({ resumed: false, sessionId: null });
    const warn = await waitFor("folder.error", n); // 鬼会话警告：告知用户被退回新会话
    expect(JSON.stringify(warn)).toContain("ghost-sid");
    // 退回新会话后粘性同步把别名的 sessionId 修成 null
    const l2 = (await waitFor("alias.list.data", n)) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(l2.aliases.find((a) => a.id === ghostId)?.sessionId).toBeNull();
    ws.close();
    await server.close();
  });

  it("粘性同步：当前别名下换文件夹，别名数据自动写回、不脱钩", async () => {
    aliases.create("工作", dir, "sid-1");
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-b-"));
    const { server, url } = await boot(makeConfig(), { aliases });
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.select", id: aliases.all()[0].id }));
    await waitFor("folder.bound");
    const n = inbox.length;
    ws.send(JSON.stringify({ type: "folder.bind", path: dir2 }));
    const bound = (await waitFor("folder.bound", n)) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ path: dir2, resumed: false });
    const l = (await waitFor("alias.list.data", n)) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(l.currentId).toBe(aliases.all()[0].id); // 不脱钩
    expect(l.aliases[0].folder).toBe(dir2); // 文件夹已写回别名
    expect(l.aliases[0].sessionId).toBeNull();
    ws.close();
    await server.close();
  });

  it("alias.delete：只删别名，会话映射与当前绑定不动", async () => {
    aliases.create("唯一", dir, null);
    const { server, url } = await boot(makeConfig(), { aliases });
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.select", id: aliases.all()[0].id }));
    await waitFor("folder.bound");
    const n = inbox.length; // 跳过 select 推送的旧列表
    ws.send(JSON.stringify({ type: "alias.delete", id: aliases.all()[0].id }));
    const l = (await waitFor("alias.list.data", n)) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(l.aliases).toHaveLength(0);
    expect(l.currentId).toBeNull();
    // 会话没被杀：再发消息仍走原文件夹的会话（fakeHandle 继续收到 SEND）
    ws.send(JSON.stringify({ type: "chat.send", text: "还在吗" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(sentClientMessages.some((m) => m.cwd === "SEND" && (m.opts as { text: string }).text === "还在吗")).toBe(true);
    ws.close();
    await server.close();
  });

  it("alias.update：改名后列表更新，其他字段不动", async () => {
    aliases.create("旧名", dir, null);
    const { server, url } = await boot(makeConfig(), { aliases });
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.update", id: aliases.all()[0].id, name: "新名" }));
    const l = (await waitFor("alias.list.data")) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(l.aliases[0].name).toBe("新名");
    expect(l.aliases[0].folder).toBe(dir);
    ws.close();
    await server.close();
  });

  it("folder.pick：返回注入实现给的路径", async () => {
    const { server, url } = await boot(makeConfig(), { aliases, pickFolder: () => Promise.resolve(dir) });
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "folder.pick" }));
    const picked = (await waitFor("folder.picked")) as Extract<ServerMessage, { type: "folder.picked" }>;
    expect(picked.path).toBe(dir);
    ws.close();
    await server.close();
  });

  it("未注入别名存储时 alias.list 不回包（功能关闭）", async () => {
    const { server, url } = await boot(makeConfig());
    const { ws } = await connect(url);
    const { inbox } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.list" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(inbox.some((m) => m.type === "alias.list.data")).toBe(false);
    ws.close();
    await server.close();
  });
});
