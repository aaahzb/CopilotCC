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
let fakeHandle: { send(t: string): void; abort(): void; respondPermission(id: string, a: boolean): void; setFastMode(enabled: boolean, model?: string | null): Promise<void>; fastAutoModel(): Promise<string | undefined>; close(): Promise<void> };

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
    setFastMode: vi.fn(() => Promise.resolve()),
    fastAutoModel: vi.fn(() => Promise.resolve(undefined)),
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

  it("chat.abort 经协议路由到当前会话：广播 chat.aborted 且 busy 快照变 false", async () => {
    let aborts = 0;
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
    fakeHandle.abort = () => {
      aborts += 1;
      (captured.opts.events as { onAborted(): void }).onAborted();
    };
    a.ws.send(JSON.stringify({ type: "chat.send", text: "长任务", display: "长任务" }));
    await ca.waitFor("chat.user");
    a.ws.send(JSON.stringify({ type: "chat.abort" }));
    await ca.waitFor("chat.aborted");
    expect(aborts).toBe(1);
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await cb.waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync.busy).toBe(false);
    a.ws.close();
    b.ws.close();
    await server.close();
  });

  it("生成中切换模型重建会话：旧会话被关闭，界面立即脱离 busy，新会话带新模型", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    fakeHandle.close = vi.fn(async () => {});
    a.ws.send(JSON.stringify({ type: "chat.send", text: "长任务", display: "长任务" }));
    await ca.waitFor("chat.user");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet" }));
    await ca.waitFor("chat.aborted", before); // 旧实现只换会话：busy 永真，新会话空闲又让 chat.abort 空操作
    expect(fakeHandle.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const creates = sentClientMessages.filter((m) => m.cwd !== "SEND");
      expect(creates).toHaveLength(2);
      expect(creates[1]!.opts.model).toBe("sonnet");
    });
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await cb.waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync.busy).toBe(false);
    a.ws.close();
    b.ws.close();
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

describe("原生 fast 工作区镜像", () => {
  it("busy 中 fast-only 不关闭/中止旧轮次，原生接口与双视图状态同步", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const close = vi.fn(async () => {});
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.close = close;
    fakeHandle.setFastMode = setFast;
    const b = await connect(url);
    const cb = collect(b.ws);
    a.ws.send(JSON.stringify({ type: "chat.send", text: "长任务", display: "长任务" }));
    await ca.waitFor("chat.user");
    const before = ca.inbox.length;
    const beforeB = cb.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledWith(true));
    const state = (await ca.waitFor("settings.state", before)) as Extract<ServerMessage, { type: "settings.state" }>;
    const stateB = (await cb.waitFor("settings.state", beforeB)) as Extract<ServerMessage, { type: "settings.state" }>;
    expect(state.fastMode).toBe(true);
    expect(stateB.fastMode).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(ca.inbox.slice(before).some((m) => m.type === "chat.aborted")).toBe(false);
    expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(1);
    const c = await connect(url);
    const cc = collect(c.ws);
    c.ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await cc.waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync.busy).toBe(true);
    a.ws.close(); b.ws.close(); c.ws.close();
    await server.close();
  });

  it("模型+fast 同改只重建一次；旧客户端省略 fast 不会清除偏好", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledWith(true));
    a.ws.send(JSON.stringify({ type: "client.ready" })); // 后续无标记完整帧是 ready 后的旧客户端手动设置，不是启动 hello
    await ca.waitFor("chat.sync");
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(setFast).toHaveBeenCalledTimes(1);
    expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(1);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: false }));
    await vi.waitFor(() => expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(2));
    let creates = sentClientMessages.filter((m) => m.cwd !== "SEND");
    expect(creates[1]!.opts).toMatchObject({ model: "sonnet", fastMode: false });
    expect(setFast).toHaveBeenCalledTimes(1);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledWith(true));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable" }));
    await vi.waitFor(() => expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(3));
    creates = sentClientMessages.filter((m) => m.cwd !== "SEND");
    expect(creates[2]!.opts).toMatchObject({ model: "fable", fastMode: true });
    a.ws.close();
    await server.close();
  });

  it("CC onRuntime 与 chat.done 把真实 fast 状态广播给全部视图", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const b = await connect(url);
    const cb = collect(b.ws);
    const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
    const events = captured.opts.events as {
      onRuntime(info: unknown): void;
      onDone(sessionId: string, info: unknown): void;
    };
    const info = { model: "claude-opus-5-5", effort: "high", fast: { state: "cooldown", disabledReason: "network_error" } };
    const before = ca.inbox.length;
    const beforeB = cb.inbox.length;
    events.onRuntime(info);
    const [sa, sb] = await Promise.all([ca.waitFor("settings.state", before), cb.waitFor("settings.state", beforeB)]);
    expect(sa).toMatchObject({ fastMode: false, runtime: info });
    expect(sb).toMatchObject({ runtime: info });
    events.onDone("sid-fast", info);
    const [da, db] = await Promise.all([ca.waitFor("chat.done", before), cb.waitFor("chat.done", beforeB)]);
    expect(da).toMatchObject({ fast: info.fast });
    expect(db).toMatchObject({ fast: info.fast });
    a.ws.close(); b.ws.close();
    await server.close();
  });

  it("原生 fast 应用失败只回设置错误并回滚请求，不释放仍在运行的轮次", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    fakeHandle.setFastMode = vi.fn(() => Promise.reject(new Error("native denied")));
    a.ws.send(JSON.stringify({ type: "chat.send", text: "长任务", display: "长任务" }));
    await ca.waitFor("chat.user");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true }));
    const error = await ca.waitFor("settings.error", before);
    expect(error).toMatchObject({ message: expect.stringContaining("native denied") });
    await vi.waitFor(() => {
      const states = ca.inbox.filter((m) => m.type === "settings.state") as Array<Extract<ServerMessage, { type: "settings.state" }>>;
      expect(states.at(-1)?.fastMode).toBe(false);
    });
    expect(ca.inbox.slice(before).some((m) => m.type === "chat.aborted")).toBe(false);
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = (await cb.waitFor("chat.sync")) as Extract<ServerMessage, { type: "chat.sync" }>;
    expect(sync.busy).toBe(true);
    a.ws.close(); b.ws.close();
    await server.close();
  });

  it("旧会话的迟到 fast 拒绝不会回滚新会话设置或产生设置错误", async () => {
    const first = fakeHandle;
    const second = {
      send: () => {},
      abort: () => {},
      respondPermission: () => {},
      setFastMode: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    };
    let creates = 0;
    const { server, url } = await boot({
      createSession: ((cwd: string, opts: Record<string, unknown>) => {
        sentClientMessages.push({ cwd, opts });
        return creates++ === 0 ? first : second;
      }) as never,
    });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    let rejectFirst!: (e: Error) => void;
    first.setFastMode = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true }));
    await vi.waitFor(() => expect(first.setFastMode).toHaveBeenCalledWith(true));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: true, fields: ["model"] }));
    await vi.waitFor(() => expect(creates).toBe(2));
    const before = ca.inbox.length;
    rejectFirst(new Error("stale session denied"));
    await new Promise((r) => setTimeout(r, 50));
    expect(ca.inbox.slice(before).some((m) => m.type === "settings.error")).toBe(false);
    const states = ca.inbox.filter((m) => m.type === "settings.state") as Array<Extract<ServerMessage, { type: "settings.state" }>>;
    expect(states.at(-1)?.fastMode).toBe(true);
    expect(sentClientMessages.filter((m) => m.cwd !== "SEND")[1]?.opts).toMatchObject({ model: "sonnet", fastMode: true });
    a.ws.close();
    await server.close();
  });

  it("被新请求取代的迟到 fast 拒绝被忽略，当前请求值不回滚", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    let rejectFirst!: (e: Error) => void;
    let resolveSecond!: () => void;
    fakeHandle.setFastMode = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecond = resolve; }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(2));
    const before = ca.inbox.length;
    rejectFirst(new Error("superseded request denied"));
    await new Promise((r) => setTimeout(r, 50));
    expect(ca.inbox.slice(before).some((m) => m.type === "settings.error")).toBe(false);
    const states = ca.inbox.filter((m) => m.type === "settings.state") as Array<Extract<ServerMessage, { type: "settings.state" }>>;
    expect(states.at(-1)?.fastMode).toBe(false);
    resolveSecond();
    a.ws.close();
    await server.close();
  });

  it("连续 fast 请求都被原生拒绝时，回滚到最后已接受的请求值", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    let rejectFirst!: (e: Error) => void;
    let rejectSecond!: (e: Error) => void;
    fakeHandle.setFastMode = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSecond = reject; }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(2));
    rejectFirst(new Error("first denied"));
    await new Promise((r) => setTimeout(r, 20));
    const before = ca.inbox.length;
    rejectSecond(new Error("second denied"));
    await ca.waitFor("settings.error", before);
    const states = ca.inbox.filter((m) => m.type === "settings.state") as Array<Extract<ServerMessage, { type: "settings.state" }>>;
    expect(states.at(-1)?.fastMode).toBe(false);
    a.ws.close();
    await server.close();
  });

  it("fast on-off-on 的旧迟到拒绝不会回滚最新同值请求", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const rejectors: Array<(e: Error) => void> = [];
    const resolvers: Array<() => void> = [];
    fakeHandle.setFastMode = vi.fn(() => new Promise<void>((resolve, reject) => {
      resolvers.push(resolve);
      rejectors.push(reject);
    }));
    for (const fastMode of [true, false, true]) {
      a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode, fastOnly: true }));
    }
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(3));
    const before = ca.inbox.length;
    rejectors[0]!(new Error("stale same-value denied"));
    await new Promise((r) => setTimeout(r, 30));
    resolvers[1]!();
    resolvers[2]!();
    await new Promise((r) => setTimeout(r, 30));
    expect(ca.inbox.slice(before).some((m) => m.type === "settings.error")).toBe(false);
    const states = ca.inbox.filter((m) => m.type === "settings.state") as Array<Extract<ServerMessage, { type: "settings.state" }>>;
    expect(states.at(-1)?.fastMode).toBe(true);
    a.ws.close();
    await server.close();
  });


  it("重启后的非默认 hello 与恢复快照均省略空 runtime，保留扩展缓存", async () => {
    const storeFile = path.join(dir, "workspace.json");
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", effort: "high", fastMode: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const states = ca.inbox.filter((m) => m.type === "settings.state");
    expect(states.length).toBeGreaterThanOrEqual(2);
    for (const state of states) expect(state).not.toHaveProperty("runtime");
    a.ws.close();
    await server.close();
  });

  it("主动新建会话广播权威空 runtime，随后接入的新视图也不能沿用旧真值", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
    const events = captured.opts.events as { onRuntime(info: unknown): void };
    events.onRuntime({ model: "claude-opus-5-5", effort: "high", fast: { state: "on" } });
    await ca.waitFor("settings.state");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "session.new" }));
    await ca.waitFor("folder.bound", before);
    await new Promise((r) => setTimeout(r, 30));
    const reset = ca.inbox.slice(before).find((m) => m.type === "settings.state");
    expect(reset).toMatchObject({ runtime: {} });
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const snapshot = await cb.waitFor("settings.state");
    expect(snapshot).toMatchObject({ runtime: {} });
    a.ws.close(); b.ws.close();
    await server.close();
  });


  it("fastOnly 请求忽略视图里的旧模型权限 effort，不把 fast 切换变成重建", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", effort: "high", fastMode: false }));
    await vi.waitFor(() => expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(2));
    const beforeCreates = sentClientMessages.filter((m) => m.cwd !== "SEND").length;
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "fable", effort: "low", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledWith(true, "opus"));
    expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(beforeCreates);
    const states = ca.inbox.slice(before).filter((m) => m.type === "settings.state");
    expect(states.at(-1)).toMatchObject({ permissionMode: "auto", model: "opus", effort: "high", fastMode: true });
    expect(ca.inbox.slice(before).some((m) => m.type === "chat.aborted")).toBe(false);
    a.ws.close();
    await server.close();
  });


  it("fastOnly 缺少合法 fastMode 时不按其他字段重建或中止轮次", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", effort: "high", fastMode: false }));
    await vi.waitFor(() => expect(sentClientMessages.filter((m) => m.cwd !== "SEND")).toHaveLength(2));
    const beforeCreates = sentClientMessages.filter((m) => m.cwd !== "SEND").length;
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "fable", effort: "low", fastOnly: true }));
    const state = await ca.waitFor("settings.state", before);
    await new Promise((r) => setTimeout(r, 30));
    const createsAfter = sentClientMessages.filter((m) => m.cwd !== "SEND").length;
    const aborted = ca.inbox.slice(before).some((m) => m.type === "chat.aborted");
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ permissionMode: "auto", model: "sonnet", effort: "high", fastMode: false });
    expect(createsAfter).toBe(beforeCreates);
    expect(aborted).toBe(false);
  });


  it("重启恢复后切换 fast 不广播权威空 runtime", async () => {
    const storeFile = path.join(dir, "workspace.json");
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", effort: "high", fastMode: false }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "fable", effort: "low", fastMode: true, fastOnly: true }));
    const state = await ca.waitFor("settings.state", before);
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ fastMode: true });
    expect(state).not.toHaveProperty("runtime");
  });

  it("主动新建会话的 folder.bound 标记 reset，快照绑定不标记", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    a.ws.send(JSON.stringify({ type: "chat.send", text: "首轮尚未落地" }));
    await ca.waitFor("chat.user");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "session.new" }));
    const active = await ca.waitFor("folder.bound", before);
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const snapshot = await cb.waitFor("folder.bound");
    a.ws.close(); b.ws.close();
    await server.close();
    expect(active).toMatchObject({ sessionId: null, reset: true });
    expect(snapshot).not.toHaveProperty("reset");
  });

  it("自动 hello 只给未初始化桥播种，运行中旧 hello 不覆盖服务器状态", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true, hello: true }));
    await ca.waitFor("settings.state");
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: false, hello: true }));
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    await cb.waitFor("chat.sync");
    const mirrored = cb.inbox.filter((m) => m.type === "settings.state").at(-1);
    const before = cb.inbox.length;
    b.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", effort: "high", fastMode: false, fastOnly: true }));
    const explicit = await cb.waitFor("settings.state", before);
    a.ws.close(); b.ws.close();
    await server.close();
    expect(mirrored).toMatchObject({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true });
    expect(explicit).toMatchObject({ fastMode: false }); // 只有自动 hello 被忽略，显式用户操作仍生效
  });

  it("未初始化桥先收 fastOnly 仍按完整字段播种，后续 hello 不锁定默认值", async () => {
    const storeFile = path.join(dir, "workspace.json");
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null }); // ready 恢复绑定后才应创建 Query；execution 仍保持未初始化
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true, fastOnly: true }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: false, hello: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const state = ca.inbox.filter((m) => m.type === "settings.state").at(-1);
    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8")) as { execution?: unknown };
    const created = sentClientMessages.filter((m) => m.cwd !== "SEND").at(-1);
    a.ws.close();
    await server.close();
    const expected = { permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true };
    expect(state).toMatchObject(expected);
    expect(persisted.execution).toMatchObject(expected);
    expect(created?.opts).toMatchObject(expected);
  });

  it("显式字段补丁只更新指定字段，不带回其他视图或存储里的旧 fast", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "sonnet", effort: "high", fastMode: false, hello: true }));
    await ca.waitFor("settings.state");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: true, fields: ["model"] }));
    const state = await ca.waitFor("settings.state", before);
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ permissionMode: "plan", model: "fable", effort: "high", fastMode: false });
  });

  it("旧客户端无 hello 的自动启动设置不覆盖已初始化桥", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const execution = { permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null, execution: { ...execution, fastRestore: { request: "sonnet" } } });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: false }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const state = ca.inbox.filter((m) => m.type === "settings.state").at(-1);
    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8")) as { execution?: unknown };
    const created = sentClientMessages.filter((m) => m.cwd !== "SEND").at(-1);
    a.ws.close();
    await server.close();
    expect(state).toMatchObject(execution);
    expect(persisted.execution).toMatchObject(execution);
    expect(created?.opts).toMatchObject(execution);
  });

  it("旧客户端断线前排队的显式完整设置先于自动 hello 生效", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const execution = { permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null, execution: { ...execution, fastRestore: { request: "sonnet" } } });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "acceptEdits", model: "opus", effort: "max", fastMode: false }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const state = ca.inbox.filter((m) => m.type === "settings.state").at(-1);
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ permissionMode: "acceptEdits", model: "opus", effort: "max", fastMode: false });
  });

  it("旧客户端离线显式完整设置与自动 hello 间夹有草稿时仍生效", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const execution = { permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null, execution: { ...execution, fastRestore: { request: "sonnet" } } });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "acceptEdits", model: "opus", effort: "max", fastMode: false }));
    a.ws.send(JSON.stringify({ type: "chat.draft", text: "离线草稿" }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const state = ca.inbox.filter((m) => m.type === "settings.state").at(-1);
    const sync = ca.inbox.find((m) => m.type === "chat.sync");
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ permissionMode: "acceptEdits", model: "opus", effort: "max", fastMode: false });
    expect(sync).toMatchObject({ draft: "离线草稿" });
  });

  it("旧客户端离线显式完整设置与自动 hello 间夹有 fastOnly 时仍生效", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const execution = { permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null, execution: { ...execution, fastRestore: { request: "sonnet" } } });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "acceptEdits", model: "opus", effort: "max", fastMode: true }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const state = ca.inbox.filter((m) => m.type === "settings.state").at(-1);
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ permissionMode: "acceptEdits", model: "opus", effort: "max", fastMode: false });
  });

  it("旧客户端自动启动后排队的显式 fast 设置仍生效", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const execution = { permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null, execution: { ...execution, fastRestore: { request: "sonnet" } } });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: false }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const state = ca.inbox.filter((m) => m.type === "settings.state").at(-1);
    a.ws.close();
    await server.close();
    expect(state).toMatchObject({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: false });
  });

  it("执行设置跨重启由桥接恢复，旧 hello 不回滚且提前写入不清绑定", async () => {
    const storeFile = path.join(dir, "workspace.json");
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null });
    const firstBoot = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(firstBoot.url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true, hello: true }));
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    await ca.waitFor("chat.sync");
    const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8")) as { folder?: string; execution?: unknown };
    a.ws.close();
    await firstBoot.server.close();
    const secondBoot = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const b = await connect(secondBoot.url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: false, hello: true }));
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    await cb.waitFor("chat.sync");
    const restored = cb.inbox.filter((m) => m.type === "settings.state").at(-1);
    const created = sentClientMessages.filter((m) => m.cwd !== "SEND").at(-1)?.opts;
    b.ws.close();
    await secondBoot.server.close();
    expect(persisted.folder).toBe(dir);
    expect(persisted.execution).toMatchObject({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true });
    expect(restored).toMatchObject({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true });
    expect(created).toMatchObject({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true });
  });

  it("fast-only 标记 fastPending 并延续到快照，CC fast 真值到达后清除", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    const pending = await ca.waitFor("settings.state", before);
    const b = await connect(url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    const snapshot = await cb.waitFor("settings.state");
    const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
    const events = captured.opts.events as { onRuntime(info: unknown): void };
    const confirmedBefore = ca.inbox.length;
    events.onRuntime({ model: "claude-opus-5-5", fast: { state: "on" }, fastFresh: true });
    const confirmed = await ca.waitFor("settings.state", confirmedBefore);
    a.ws.close(); b.ws.close();
    await server.close();
    expect(pending).toMatchObject({ fastMode: true, fastPending: true });
    expect(snapshot).toMatchObject({ fastMode: true, fastPending: true });
    expect(confirmed).toMatchObject({ runtime: { fast: { state: "on" } } });
    expect(confirmed).not.toHaveProperty("fastPending");
  });

  it("fastPending 不被缓存 fast 或 stale onDone 清除，仅新真值确认", async () => {
    const { server, url } = await boot();
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await ca.waitFor("settings.state", before);
    const captured = sentClientMessages.find((m) => m.cwd !== "SEND")!;
    const events = captured.opts.events as {
      onRuntime(info: { model?: string; fast?: { state: "off" | "on" }; fastFresh?: boolean }): void;
      onDone(sessionId: string, info: { model?: string; fast?: { state: "off" | "on" }; fastFresh?: boolean }): void;
    };
    const staleBefore = ca.inbox.length;
    events.onRuntime({ model: "claude-opus-5-5", fast: { state: "off" }, fastFresh: false });
    const stale = await ca.waitFor("settings.state", staleBefore);
    const doneBefore = ca.inbox.length;
    events.onDone("sid-stale", { model: "claude-opus-5-5", fast: { state: "off" }, fastFresh: false });
    const staleDone = await ca.waitFor("chat.done", doneBefore);
    const freshBefore = ca.inbox.length;
    events.onRuntime({ fast: { state: "on" }, fastFresh: true });
    const confirmed = await ca.waitFor("settings.state", freshBefore);
    a.ws.close();
    await server.close();
    expect(stale).toMatchObject({ fastPending: true });
    expect(stale).not.toHaveProperty("runtime.fast");
    expect(staleDone).not.toHaveProperty("fast");
    expect(confirmed).toMatchObject({ runtime: { fast: { state: "on" } } });
    expect(confirmed).not.toHaveProperty("fastPending");
  });

  it("client.ready 恢复绑定不标记 reset，主动新建仍标记", async () => {
    const storeFile = path.join(dir, "workspace.json");
    new WorkspaceStore(storeFile).save({ folder: dir, aliasId: null });
    const { server, url } = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const a = await connect(url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "client.ready" }));
    const restored = await ca.waitFor("folder.bound");
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "session.new" }));
    const active = await ca.waitFor("folder.bound", before);
    a.ws.close();
    await server.close();
    expect(restored).not.toHaveProperty("reset");
    expect(active).toMatchObject({ reset: true });
  });

});
