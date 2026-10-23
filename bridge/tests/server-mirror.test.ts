/** 镜像工作区：多视图广播与快照（独立窗口模式底座）。与 server.test.ts 同范式但自包含（助手函数本地复制）。 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer, type ServerDeps } from "../src/server";
import { slugifyPath } from "../src/transcript";
import { SessionManager } from "../src/session-manager";
import { AliasManager } from "../src/alias-manager";
import { WorkspaceStore } from "../src/workspace-store";
import type { BridgeConfig } from "../src/config";
import type { ServerMessage } from "../src/protocol";

let dir: string;
let sessions: SessionManager;
let sentClientMessages: Array<{ cwd: string; opts: Record<string, unknown> }>;
let fakeHandle: { send(t: string): void; abort(): void; respondPermission(id: string, a: boolean): void; close(): Promise<void> };

/** 构造测试配置，默认端口 0（系统分配） */
function makeConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return { token: "tok", port: 0, allowedOrigins: [], createdAt: "", ...over };
}

/** 启动服务并返回连接 URL；extra 可传 aliases/openFolder 等附加依赖 */
async function boot(extra: Partial<ServerDeps> = {}) {
  const server = await startServer({
    config: makeConfig(),
    sessions,
    createSession: ((cwd: string, opts: Record<string, unknown>) => {
      sentClientMessages.push({ cwd, opts });
      return fakeHandle;
    }) as never,
    ...extra,
  });
  return { server, url: `ws://127.0.0.1:${server.port}/ws` };
}

/** 连接并收第一条消息（auth.ok） */
function connect(url: string): Promise<{ ws: WebSocket; first: ServerMessage }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=tok`);
    ws.once("message", (d) => resolve({ ws, first: JSON.parse(d.toString()) }));
    ws.once("error", reject);
  });
}

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-mirror-"));
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

describe("镜像工作区（多视图广播与快照）", () => {
  it("第二连接收到状态广播；chat.send 的 chat.user 双端一致且转发会话", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    // 第二视图接入（不发 client.ready 时不拿快照，先验证纯广播）
    const b = await connect(url);
    const cb = collect(b.ws);
    a.ws.send(JSON.stringify({ type: "chat.send", text: "完整文本", display: "原文", note: "附带说明" }));
    const [ua, ub] = await Promise.all([ca.waitFor("chat.user"), cb.waitFor("chat.user")]);
    expect(ua).toEqual(ub); // 双端气泡天然一致（回显由桥接统一广播）
    expect(ua).toMatchObject({ type: "chat.user", display: "原文", sent: "完整文本", note: "附带说明" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentClientMessages.some((m) => m.cwd === "SEND" && (m.opts as { text: string }).text === "完整文本")).toBe(true);
    a.ws.close();
    b.ws.close();
    await server.close();
  });

  it("chat.delta 真流式广播：每帧即达全部连接", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    a.ws.send(JSON.stringify({ type: "chat.send", text: "hi", display: "hi" }));
    await ca.waitFor("chat.user");
    const b = await connect(url);
    const cb = collect(b.ws);
    const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
    const events = captured.opts.events as { onDelta(t: string): void };
    events.onDelta("你");
    events.onDelta("好");
    await vi.waitFor(() => {
      expect(ca.inbox.filter((m) => m.type === "chat.delta").map((m) => (m as { text: string }).text)).toEqual(["你", "好"]);
      expect(cb.inbox.filter((m) => m.type === "chat.delta").map((m) => (m as { text: string }).text)).toEqual(["你", "好"]);
    });
    a.ws.close();
    b.ws.close();
    await server.close();
  });

  it("中途接入快照：client.ready 按序收 folder.bound → history → lists → chat.sync（含在途气泡与流式文本）", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
    process.env.CCC_FAKE_HOME = fakeHome;
    try {
      const projDir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(dir)));
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "sid-1.jsonl"), JSON.stringify({ type: "user", message: { content: "旧消息" } }) + "\n", "utf-8");
      sessions.set(dir, { sessionId: "sid-1", title: "旧会话", updatedAt: "x" });
      const { server, url } = await boot({ aliases: new AliasManager(path.join(dir, "aliases.json")) });
      const a = await connect(url);
      const ca = collect(a.ws);
      a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
      await ca.waitFor("folder.bound");
      a.ws.send(JSON.stringify({ type: "chat.send", text: "在途问题", display: "在途问题" }));
      await ca.waitFor("chat.user");
      const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
      (captured.opts.events as { onDelta(t: string): void }).onDelta("半截回答");
      await ca.waitFor("chat.delta");
      // 吐字中途接入的新视图
      const b = await connect(url);
      const cb = collect(b.ws);
      b.ws.send(JSON.stringify({ type: "client.ready" }));
      await cb.waitFor("chat.sync");
      const types = cb.inbox.map((m) => m.type);
      const seq: ServerMessage["type"][] = ["folder.bound", "session.history.data", "session.list.data", "alias.list.data", "chat.sync"];
      const idx = seq.map((t) => types.indexOf(t));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((x, y) => x - y)); // 严格按序
      const sync = cb.inbox.find((m) => m.type === "chat.sync") as Extract<ServerMessage, { type: "chat.sync" }>;
      expect(sync.busy).toBe(true);
      expect(sync.streamText).toBe("半截回答");
      expect(sync.user).toEqual({ display: "在途问题", sent: "在途问题" });
      expect(sync.permReq).toBeNull();
      a.ws.close();
      b.ws.close();
      await server.close();
    } finally {
      delete process.env.CCC_FAKE_HOME;
    }
  });

  it("空工作区快照：无绑定态（无 folder.bound）但别名列表照常下发——全局数据不受绑定门控", async () => {
    const aliases = new AliasManager(path.join(dir, "aliases.json"));
    aliases.create("甲", dir, null);
    aliases.create("乙", dir, null);
    const { server, url } = await boot({ aliases });
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync).toMatchObject({ busy: false, streamText: "", user: null, permReq: null, draft: "" });
    expect(inbox.some((m) => m.type === "folder.bound")).toBe(false); // 无绑定态：视图据 chat.sync 走首绑引导
    // 回归：未绑定也必须收到别名列表（镜像重写曾把它关进 folder 门内 → 全新桥接下别名下拉永空）
    const al = inbox.find((m) => m.type === "alias.list.data") as Extract<ServerMessage, { type: "alias.list.data" }> | undefined;
    expect(al?.aliases.map((a) => a.name)).toEqual(["甲", "乙"]);
    expect(inbox.indexOf(al!)).toBeLessThan(inbox.indexOf(sync)); // 列表先于 chat.sync 到达
    ws.close();
    await server.close();
  });

  it("chat.draft 镜像：上报方不回显，其它视图收到；快照携带草稿", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    const b = await connect(url);
    const cb = collect(b.ws);
    a.ws.send(JSON.stringify({ type: "chat.draft", text: "写到一半" }));
    const d = (await cb.waitFor("chat.draft")) as Extract<ServerMessage, { type: "chat.draft" }>;
    expect(d.text).toBe("写到一半");
    await new Promise((r) => setTimeout(r, 50));
    expect(ca.inbox.some((m) => m.type === "chat.draft")).toBe(false); // 上报方不回显（防光标跳）
    // 第三视图快照补齐草稿
    const c = await connect(url);
    const cc = collect(c.ws);
    c.ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await cc.waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync.draft).toBe("写到一半");
    a.ws.close();
    b.ws.close();
    c.ws.close();
    await server.close();
  });

  it("folder.open：未绑定报错；选中别名后开别名文件夹并刷新续聊脚本", async () => {
    const aliases = new AliasManager(path.join(dir, "aliases.json"));
    aliases.create("笔记", dir, null);
    const opened: string[] = [];
    const { server, url } = await boot({ aliases, openFolder: (p: string) => { opened.push(p); return Promise.resolve(true); } });
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    // 未绑定：报错
    ws.send(JSON.stringify({ type: "folder.open" }));
    const err = await waitFor("folder.error");
    expect(err.type).toBe("folder.error");
    // 选中别名后打开：路径=别名文件夹，脚本已写入并在应答里带文件名
    ws.send(JSON.stringify({ type: "alias.select", id: aliases.all()[0].id }));
    await waitFor("folder.bound");
    ws.send(JSON.stringify({ type: "folder.open" }));
    const ok = (await waitFor("folder.opened")) as Extract<ServerMessage, { type: "folder.opened" }>;
    expect(ok.path).toBe(dir);
    expect(ok.script).toBe(process.platform === "win32" ? "继续聊天-笔记.bat" : "继续聊天-笔记.sh"); // 闪示当前平台可直跑的那个
    expect(opened).toEqual([dir]);
    expect(fs.existsSync(path.join(dir, "继续聊天-笔记.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "继续聊天-笔记.bat"))).toBe(true); // .bat 成对落盘（Windows 直跑）
    ws.close();
    await server.close();
  });

  it("permission.response：广播 permission.resolved 到全部视图", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const b = await connect(url);
    const cb = collect(b.ws);
    a.ws.send(JSON.stringify({ type: "permission.response", requestId: "r1", allow: true }));
    const [ra, rb] = await Promise.all([ca.waitFor("permission.resolved"), cb.waitFor("permission.resolved")]);
    expect(ra).toMatchObject({ type: "permission.resolved", requestId: "r1" });
    expect(rb).toMatchObject({ type: "permission.resolved", requestId: "r1" });
    a.ws.close();
    b.ws.close();
    await server.close();
  });

  it("视图断开不杀会话：ws close 后 fakeHandle.close 未调，新视图快照拿到原绑定；桥接关停才终结", async () => {
    let closeCount = 0;
    fakeHandle.close = async () => {
      closeCount += 1;
    };
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closeCount).toBe(0); // 旧行为（ws close → claude.close）已废：会话随工作区活
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const bound = (await cb.waitFor("folder.bound")) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound.path).toBe(dir);
    b.ws.close();
    await server.close(); // 桥接整体关停才终结会话
    expect(closeCount).toBe(1);
  });
});

describe("别名会话恢复与工作区持久化（升级/重启不丢聊天记录）", () => {
  it("alias.select 别名无会话记录：回退 sessions 映射续聊，不毁映射", async () => {
    const aliases = new AliasManager(path.join(dir, "aliases.json"));
    const a = aliases.create("测试", dir, null); // 别名还没定下会话
    sessions.set(dir, { sessionId: "sid-old", title: "旧聊", updatedAt: new Date().toISOString() }); // 文件夹已有会话映射
    const { server, url } = await boot({ aliases });
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.select", id: a.id }));
    const bound = (await waitFor("folder.bound")) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound).toMatchObject({ resumed: true, sessionId: "sid-old" }); // 续上而不是新开
    expect(sentClientMessages.at(-1)?.opts.resumeId).toBe("sid-old");
    expect(sessions.get(dir)?.sessionId).toBe("sid-old"); // 映射还在（旧行为会 delete 毁映射）
    expect(aliases.get(a.id)?.sessionId).toBe("sid-old"); // 粘性同步顺手治愈别名
    ws.close();
    await server.close();
  });

  it("新会话拿到 ID 即写回当前别名（alias.sessionId 不再是永久 null）", async () => {
    const aliases = new AliasManager(path.join(dir, "aliases.json"));
    const { server, url } = await boot({ aliases });
    const { ws } = await connect(url);
    const { inbox, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "alias.create", name: "新", folder: dir, sessionId: null }));
    await waitFor("folder.bound"); // 创建语义不变：强制新会话
    await waitFor("alias.list.data"); // 先等创建时的列表推送（sessionId 还是 null），防竞态误取
    const n = inbox.length;
    // 模拟 SDK 初始化完成上报会话 ID（fake 的 events 在 createSession 的 opts 里）
    const created = sentClientMessages.find((c) => c.cwd !== "SEND");
    expect(created).toBeTruthy();
    (created!.opts.events as { onSessionId(id: string): void }).onSessionId("sid-fresh");
    const list = (await waitFor("alias.list.data", n)) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(list.aliases[0]?.sessionId).toBe("sid-fresh");
    ws.close();
    await server.close();
  });

  it("桥接重启恢复工作区绑定：workspace.json 驱动首个视图快照（文件夹+别名）", async () => {
    const aliases1 = new AliasManager(path.join(dir, "aliases.json"));
    const storeFile = path.join(dir, "workspace.json");
    const b1 = await boot({ aliases: aliases1, workspaceStore: new WorkspaceStore(storeFile) });
    const c1 = await connect(b1.url);
    const w1 = collect(c1.ws);
    c1.ws.send(JSON.stringify({ type: "alias.create", name: "笔记", folder: dir, sessionId: null }));
    await w1.waitFor("folder.bound");
    const aliasId = aliases1.all()[0]!.id;
    expect(JSON.parse(fs.readFileSync(storeFile, "utf-8"))).toMatchObject({ folder: dir, aliasId });
    c1.ws.close();
    await b1.server.close(); // 模拟桥接重启：数据文件都在，进程状态全没
    const sessions2 = new SessionManager(path.join(dir, "sessions.json"));
    sessions2.load();
    const aliases2 = new AliasManager(path.join(dir, "aliases.json"));
    aliases2.load();
    const b2 = await boot({ sessions: sessions2, aliases: aliases2, workspaceStore: new WorkspaceStore(storeFile) });
    const c2 = await connect(b2.url);
    const w2 = collect(c2.ws);
    c2.ws.send(JSON.stringify({ type: "client.ready" }));
    const bound = (await w2.waitFor("folder.bound")) as Extract<ServerMessage, { type: "folder.bound" }>;
    expect(bound.path).toBe(dir); // 快照自带恢复绑定，不等扩展回绑
    const list = (await w2.waitFor("alias.list.data")) as Extract<ServerMessage, { type: "alias.list.data" }>;
    expect(list.currentId).toBe(aliasId); // 别名也恢复
    c2.ws.close();
    await b2.server.close();
  });

  it("持久化的文件夹已失效：放弃恢复，工作区保持未绑定", async () => {
    const storeFile = path.join(dir, "workspace.json");
    new WorkspaceStore(storeFile).save({ folder: path.join(dir, "ghost"), aliasId: null });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const { ws } = await connect(url);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync.busy).toBe(false);
    expect(sentClientMessages.filter((c) => c.cwd !== "SEND")).toHaveLength(0); // 没有为失效文件夹建会话
    ws.close();
    await server.close();
  });
});
