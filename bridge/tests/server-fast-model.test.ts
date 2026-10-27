import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer, type ServerDeps } from "../src/server";
import { SessionManager } from "../src/session-manager";
import { WorkspaceStore, type WorkspaceExecutionSettings } from "../src/workspace-store";
import type { BridgeConfig } from "../src/config";
import type { ServerMessage } from "../src/protocol";

const FABLE = "claude-fable-5-1";
type FastState = Extract<ServerMessage, { type: "settings.state" }>;
interface FakeHandle {
  send(text: string): void;
  abort(): void;
  respondPermission(id: string, allow: boolean): void;
  setFastMode(enabled: boolean, model?: string | null): Promise<void>;
  fastAutoModel(): Promise<string | undefined>;
  close(): Promise<void>;
}
interface Booted { server: { port: number; close(): Promise<void> }; url: string }
interface Connected { ws: WebSocket; first: ServerMessage }
interface Collector {
  inbox: ServerMessage[];
  waitFor(type: string, from?: number, timeoutMs?: number): Promise<ServerMessage>;
}

let dir: string;
let sessions: SessionManager;
let sent: Array<{ cwd: string; opts: Record<string, unknown> }>;
let fakeHandle: FakeHandle;

/** 创建可替换原生控制方法的会话替身。 */
function makeFakeHandle(): FakeHandle {
  return {
    send: (text: string) => sent.push({ cwd: "SEND", opts: { text } }),
    abort: () => {},
    respondPermission: () => {},
    setFastMode: vi.fn(() => Promise.resolve()),
    fastAutoModel: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve()),
  };
}

/** 返回仅监听本机随机端口的测试配置。 */
function makeConfig(): BridgeConfig {
  return { token: "tok", port: 0, allowedOrigins: [], createdAt: "" };
}

/** 启动桥接并记录 Query 创建参数。 */
async function boot(extra: Partial<ServerDeps> = {}): Promise<Booted> {
  const server = await startServer({
    config: makeConfig(),
    sessions,
    createSession: ((cwd: string, opts: Record<string, unknown>) => {
      sent.push({ cwd, opts });
      return fakeHandle;
    }) as never,
    ...extra,
  });
  return { server, url: `ws://127.0.0.1:${server.port}/ws` };
}

/** 建立已认证连接并消费 auth.ok。 */
function connect(url: string): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=tok`);
    ws.once("message", (data) => resolve({ ws, first: JSON.parse(data.toString()) as ServerMessage }));
    ws.once("error", reject);
  });
}

/** 累计消息并支持从指定下标等待新帧。 */
function collect(ws: WebSocket): Collector {
  const inbox: ServerMessage[] = [];
  ws.on("message", (data) => inbox.push(JSON.parse(data.toString()) as ServerMessage));
  const waitFor = (type: string, from = 0, timeoutMs = 3000): Promise<ServerMessage> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const hit = inbox.slice(from).find((message) => message.type === type);
        if (hit) { clearInterval(timer); resolve(hit); return; }
        if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`等待 ${type} 超时`)); }
      }, 20);
    });
  return { inbox, waitFor };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-fast-model-"));
  sessions = new SessionManager(path.join(dir, "sessions.json"));
  sent = [];
  fakeHandle = makeFakeHandle();
});

/** 先播种明确的 off，再绑定文件夹，避免把后续 on 误当 seeding。 */
async function openWorkspace(model?: string, extra: Partial<ServerDeps> = {}): Promise<{ booted: Booted; a: Connected; ca: Collector }> {
  const booted = await boot(extra);
  const a = await connect(booted.url);
  const ca = collect(a.ws);
  a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", ...(model ? { model } : {}), fastMode: false, hello: true }));
  await ca.waitFor("settings.state");
  a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
  await ca.waitFor("folder.bound");
  return { booted, a, ca };
}

/** 返回最近的请求设置帧。 */
function lastState(inbox: ServerMessage[]): FastState | undefined {
  return inbox.filter((message): message is FastState => message.type === "settings.state").at(-1);
}

/** 读取测试工作区的权威执行设置。 */
function execution(file: string): WorkspaceExecutionSettings {
  return (JSON.parse(fs.readFileSync(file, "utf-8")) as { execution: WorkspaceExecutionSettings }).execution;
}

/** 等待已接收的 Promise 回包及其后续状态提交。 */
function settle(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 30)); }

describe("fast 模型提升与恢复", () => {
  it("Sonnet/off 在 busy 中提升到 Opus/on，off 恢复 Sonnet且不打断轮次", async () => {
    const { booted, a, ca } = await openWorkspace("sonnet");
    const setFast = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const abort = vi.fn();
    fakeHandle.setFastMode = setFast;
    fakeHandle.close = close;
    fakeHandle.abort = abort;
    a.ws.send(JSON.stringify({ type: "chat.send", text: "长任务", display: "长任务" }));
    await ca.waitFor("chat.user");
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    expect(setFast).toHaveBeenLastCalledWith(true, "opus");
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: true });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(2));
    expect(setFast).toHaveBeenLastCalledWith(false, "sonnet");
    expect(lastState(ca.inbox)).toMatchObject({ model: "sonnet", fastMode: false });
    expect(close).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(ca.inbox.some((message) => message.type === "chat.aborted")).toBe(false);
    expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(1);
    const b = await connect(booted.url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    expect(await cb.waitFor("chat.sync")).toMatchObject({ busy: true });
    a.ws.close(); b.ws.close();
    await booted.server.close();
  });

  it("首轮前自动档保存 CC applied 模型，off 恢复具体 Fable 请求", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const auto = vi.fn(() => Promise.resolve(FABLE));
    const setFast = vi.fn(() => Promise.resolve());
    const { booted, a, ca } = await openWorkspace(undefined, { workspaceStore: store });
    fakeHandle.fastAutoModel = auto;
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    await settle();
    expect(auto).toHaveBeenCalledTimes(1);
    expect(execution(storeFile)).toMatchObject({ model: "opus", fastMode: true, fastRestore: { request: null, actualModel: FABLE } });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(2));
    await settle();
    expect(setFast).toHaveBeenLastCalledWith(false, FABLE);
    expect(lastState(ca.inbox)).toMatchObject({ model: FABLE, fastMode: false });
    expect(execution(storeFile).fastRestore).toBeUndefined();
    expect(lastState(ca.inbox)?.runtime?.model).toBeUndefined();
    a.ws.close();
    await booted.server.close();
  });

  it("自动恢复证据跨重启后，off 不依赖旧 Query 或再次读取元数据", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const first = await openWorkspace(undefined, { workspaceStore: store });
    fakeHandle.fastAutoModel = vi.fn(() => Promise.resolve(FABLE));
    first.a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(1));
    await settle();
    expect(execution(storeFile).fastRestore).toEqual({ request: null, actualModel: FABLE });
    first.a.ws.close();
    await first.booted.server.close();

    fakeHandle = makeFakeHandle();
    const auto = vi.fn(() => Promise.resolve(undefined));
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.fastAutoModel = auto;
    fakeHandle.setFastMode = setFast;
    const second = await boot({ workspaceStore: new WorkspaceStore(storeFile) });
    const b = await connect(second.url);
    const cb = collect(b.ws);
    b.ws.send(JSON.stringify({ type: "client.ready" }));
    await cb.waitFor("chat.sync");
    b.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    await settle();
    expect(setFast).toHaveBeenCalledWith(false, FABLE);
    expect(auto).not.toHaveBeenCalled();
    expect(lastState(cb.inbox)).toMatchObject({ model: FABLE, fastMode: false });
    b.ws.close();
    await second.server.close();
  });
  it("自动恢复证据未知时仅关 fast并保留 Opus，同时给出非致命警告", async () => {
    const { booted, a, ca } = await openWorkspace();
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    await settle();
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: true });
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    const warning = await ca.waitFor("settings.error", before);
    expect(warning).toMatchObject({ message: expect.stringContaining("未猜测恢复模型") });
    expect(setFast.mock.calls).toEqual([[true, "opus"], [false, null]]);
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: false });
    expect(ca.inbox.some((message) => message.type === "chat.aborted")).toBe(false);
    a.ws.close();
    await booted.server.close();
  });

  it("尚无 Query 的自动 on/off 只保存偏好，off 直接回到自动且无需警告", async () => {
    const booted = await boot();
    const a = await connect(booted.url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, hello: true }));
    await ca.waitFor("settings.state");
    let before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await ca.waitFor("settings.state", before);
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: true });
    before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(lastState(ca.inbox)?.fastMode).toBe(false));
    expect(lastState(ca.inbox)?.model).toBeUndefined();
    expect(ca.inbox.some((message) => message.type === "settings.error")).toBe(false);
    expect(fakeHandle.setFastMode).not.toHaveBeenCalled();
    a.ws.close();
    await booted.server.close();
  });

  it("fast 期间手动 Fable 后重复 on 是幂等，off 保留最新手动模型", async () => {
    const { booted, a, ca } = await openWorkspace("sonnet");
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", fastMode: true, fields: ["model"] }));
    await vi.waitFor(() => expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(2));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await settle();
    expect(setFast).toHaveBeenCalledTimes(1);
    expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(2);
    expect(lastState(ca.inbox)).toMatchObject({ model: "fable", fastMode: true });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(2));
    expect(setFast).toHaveBeenLastCalledWith(false);
    expect(lastState(ca.inbox)).toMatchObject({ model: "fable", fastMode: false });
    a.ws.close();
    await booted.server.close();
  });
  it("fast 期间同值选择 Opus 也更新基线，off 不回到更早的 Sonnet", async () => {
    const { booted, a, ca } = await openWorkspace("sonnet");
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "opus", fastMode: true, fields: ["model"] }));
    await settle();
    expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(1);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(2));
    expect(setFast).toHaveBeenLastCalledWith(false);
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: false });
    a.ws.close();
    await booted.server.close();
  });

  it("fast 期间手动切回自动后，off 不改模型也不伪造具体恢复值", async () => {
    const { booted, a, ca } = await openWorkspace("sonnet");
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fields: ["model"] }));
    await vi.waitFor(() => expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(2));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(2));
    expect(setFast).toHaveBeenLastCalledWith(false);
    expect(lastState(ca.inbox)?.model).toBeUndefined();
    expect(ca.inbox.some((message) => message.type === "settings.error")).toBe(false);
    a.ws.close();
    await booted.server.close();
  });

  it("模型与 fast 同帧按新提升、已开启、关闭分别计算且每次只重建一次", async () => {
    const { booted, a } = await openWorkspace();
    const setFast = vi.fn(() => Promise.resolve());
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: true, fields: ["model", "fastMode"] }));
    await vi.waitFor(() => expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(2));
    expect(sent.filter((message) => message.cwd !== "SEND").at(-1)?.opts).toMatchObject({ model: "opus", fastMode: true });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "fable", fastMode: true, fields: ["model", "fastMode"] }));
    await vi.waitFor(() => expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(3));
    expect(sent.filter((message) => message.cwd !== "SEND").at(-1)?.opts).toMatchObject({ model: "fable", fastMode: true });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: false, fields: ["model", "fastMode"] }));
    await vi.waitFor(() => expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(4));
    expect(sent.filter((message) => message.cwd !== "SEND").at(-1)?.opts).toMatchObject({ model: "sonnet", fastMode: false });
    expect(setFast).not.toHaveBeenCalled();
    a.ws.close();
    await booted.server.close();
  });
  it("seeding 的 Sonnet/on 不提升，建立自身基线供后续 off 使用", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const booted = await boot({ workspaceStore: store });
    const a = await connect(booted.url);
    const ca = collect(a.ws);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: true, hello: true }));
    await ca.waitFor("settings.state");
    expect(lastState(ca.inbox)).toMatchObject({ model: "sonnet", fastMode: true });
    expect(execution(storeFile).fastRestore).toEqual({ request: "sonnet" });
    a.ws.send(JSON.stringify({ type: "folder.bind", path: dir }));
    await ca.waitFor("folder.bound");
    expect(sent.at(-1)?.opts).toMatchObject({ model: "sonnet", fastMode: true });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(1));
    expect(fakeHandle.setFastMode).toHaveBeenCalledWith(false);
    expect(lastState(ca.inbox)).toMatchObject({ model: "sonnet", fastMode: false });
    a.ws.close();
    await booted.server.close();
  });

  it("on/off 原生失败分别完整回滚模型、fast 与恢复基线", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const { booted, a, ca } = await openWorkspace("sonnet", { workspaceStore: store });
    const setFast = vi.fn()
      .mockRejectedValueOnce(new Error("on denied"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("off denied"));
    fakeHandle.setFastMode = setFast;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await ca.waitFor("settings.error");
    expect(lastState(ca.inbox)).toMatchObject({ model: "sonnet", fastMode: false });
    expect(execution(storeFile)).toMatchObject({ model: "sonnet", fastMode: false });
    expect(execution(storeFile).fastRestore).toBeUndefined();
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(2));
    await settle();
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: true });
    expect(execution(storeFile).fastRestore).toEqual({ request: "sonnet" });
    const before = ca.inbox.length;
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await ca.waitFor("settings.error", before);
    expect(setFast).toHaveBeenLastCalledWith(false, "sonnet");
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: true });
    expect(execution(storeFile)).toMatchObject({ model: "opus", fastMode: true, fastRestore: { request: "sonnet" } });
    a.ws.close();
    await booted.server.close();
  });

  it("延迟自动快照下 on/off/on 使用各自目标，最终 off 恢复同一 Fable", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const { booted, a, ca } = await openWorkspace(undefined, { workspaceStore: store });
    let release!: () => void;
    const capture = new Promise<string>((resolve) => { release = () => resolve(FABLE); });
    const setFast = vi.fn(() => capture.then(() => {}));
    fakeHandle.setFastMode = setFast;
    fakeHandle.fastAutoModel = vi.fn(() => capture);
    for (const fastMode of [true, false, true]) {
      a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode, fastOnly: true }));
    }
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(3));
    release();
    await settle();
    expect(setFast.mock.calls).toEqual([[true, "opus"], [false, null], [true, "opus"]]);
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: true });
    expect(execution(storeFile)).toMatchObject({ model: "opus", fastMode: true, fastRestore: { request: null, actualModel: FABLE } });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(setFast).toHaveBeenCalledTimes(4));
    await settle();
    expect(setFast).toHaveBeenLastCalledWith(false, FABLE);
    expect(lastState(ca.inbox)).toMatchObject({ model: FABLE, fastMode: false });
    a.ws.close();
    await booted.server.close();
  });

  it("旧 Query 的迟到自动快照不会覆盖手动 Sonnet 的新基线", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const first = fakeHandle;
    const second = makeFakeHandle();
    let creates = 0;
    const { booted, a, ca } = await openWorkspace(undefined, {
      workspaceStore: store,
      createSession: ((cwd: string, opts: Record<string, unknown>) => {
        sent.push({ cwd, opts });
        return creates++ === 0 ? first : second;
      }) as never,
    });
    let release!: () => void;
    const capture = new Promise<string>((resolve) => { release = () => resolve(FABLE); });
    first.setFastMode = vi.fn(() => capture.then(() => {}));
    first.fastAutoModel = vi.fn(() => capture);
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(first.setFastMode).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "sonnet", fastMode: true, fields: ["model"] }));
    await vi.waitFor(() => expect(creates).toBe(2));
    release();
    await settle();
    expect(lastState(ca.inbox)).toMatchObject({ model: "sonnet", fastMode: true });
    expect(execution(storeFile).fastRestore).toEqual({ request: "sonnet" });
    a.ws.close();
    await booted.server.close();
  });
  it("同值基线更新不让仍在途的 on 失败失去完整回滚", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const { booted, a, ca } = await openWorkspace("sonnet", { workspaceStore: store });
    let rejectOn!: (error: Error) => void;
    fakeHandle.setFastMode = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOn = reject; }));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "opus", fastMode: true, fields: ["model"] }));
    await settle();
    expect(sent.filter((message) => message.cwd !== "SEND")).toHaveLength(1);
    const before = ca.inbox.length;
    rejectOn(new Error("pending on denied"));
    await settle();
    expect(ca.inbox.slice(before).some((message) => message.type === "settings.error")).toBe(true);
    expect(lastState(ca.inbox)).toMatchObject({ model: "sonnet", fastMode: false });
    expect(execution(storeFile).fastRestore).toBeUndefined();
    a.ws.close();
    await booted.server.close();
  });

  it("在途 on 成功后保留同值选择更新的恢复基线", async () => {
    const storeFile = path.join(dir, "workspace.json");
    const store = new WorkspaceStore(storeFile);
    const { booted, a, ca } = await openWorkspace("sonnet", { workspaceStore: store });
    let resolveOn!: () => void;
    fakeHandle.setFastMode = vi.fn((enabled: boolean) => enabled
      ? new Promise<void>((resolve) => { resolveOn = resolve; })
      : Promise.resolve());
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(1));
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "opus", fastMode: true, fields: ["model"] }));
    await settle();
    resolveOn();
    await settle();
    expect(execution(storeFile).fastRestore).toEqual({ request: "opus" });
    a.ws.send(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false, fastOnly: true }));
    await vi.waitFor(() => expect(fakeHandle.setFastMode).toHaveBeenCalledTimes(2));
    await settle();
    expect(fakeHandle.setFastMode).toHaveBeenLastCalledWith(false);
    expect(lastState(ca.inbox)).toMatchObject({ model: "opus", fastMode: false });
    expect(execution(storeFile).fastRestore).toBeUndefined();
    a.ws.close();
    await booted.server.close();
  });

});
