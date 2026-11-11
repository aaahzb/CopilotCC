import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type StartedServer } from "../src/server";
import { SessionManager } from "../src/session-manager";
import { AliasManager } from "../src/alias-manager";
import { WorkspaceStore } from "../src/workspace-store";
import { transcriptProjectsRoot, slugifyPath } from "../src/transcript";
import type { ClaudeSessionLike } from "../src/claude-session";
import type { ServerMessage } from "../src/protocol";
import type { TerminalRuntimeHandle, TerminalStartContext, TerminalLeaseRecord } from "../src/terminal-lease";
import { TerminalLeaseStore } from "../src/terminal-store";
import { SystemTerminalAdapter } from "../src/system-terminal";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";
const tempDirs: string[] = [];
const servers: StartedServer[] = [];
const sockets: WebSocket[] = [];
let previousConfigDir: string | undefined;

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const server of servers.splice(0)) await server.close();
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Collector {
  inbox: ServerMessage[];
  waitFor(type: ServerMessage["type"], from?: number): Promise<ServerMessage>;
  waitWhere(predicate: (message: ServerMessage) => boolean, description: string): Promise<ServerMessage>;
}

function collect(ws: WebSocket): Collector {
  const inbox: ServerMessage[] = [];
  ws.on("message", (data) => inbox.push(JSON.parse(data.toString()) as ServerMessage));
  const waitWhere = async (predicate: (message: ServerMessage) => boolean, description: string): Promise<ServerMessage> => {
    await vi.waitFor(() => {
      if (!inbox.some(predicate)) throw new Error(`等待 ${description}`);
    }, { timeout: 4000, interval: 20 });
    return inbox.find(predicate)!;
  };
  return {
    inbox,
    waitFor: (type, from = 0) => waitWhere((message) => message.type === type && inbox.indexOf(message) >= from, type),
    waitWhere,
  };
}

async function connect(port: number): Promise<{ ws: WebSocket; inbox: Collector }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, inbox: collect(ws) };
}

function transcriptFile(work: string, sessionId: string): string {
  return path.join(transcriptProjectsRoot(), slugifyPath(path.resolve(work)), `${sessionId}.jsonl`);
}

function writeTranscript(work: string, sessionId: string, text: string): void {
  const file = transcriptFile(work, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    type: "user", uuid: `uuid-${sessionId}`, timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  })}\n`, "utf8");
}

async function fixture(withAlias = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-server-terminal-"));
  tempDirs.push(dir);
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude-config");
  const work = path.join(dir, "work with space");
  const cliPath = path.join(dir, process.platform === "win32" ? "fake-claude.exe" : "fake-claude");
  fs.mkdirSync(work, { recursive: true });
  writeTranscript(work, SID_1, "初始会话");
  const sessions = new SessionManager(path.join(dir, "sessions.json"));
  sessions.set(work, { sessionId: SID_1, title: "初始会话", updatedAt: new Date().toISOString() });
  const aliases = new AliasManager(path.join(dir, "aliases.json"));
  const alias = withAlias ? aliases.create("当前工作", work, SID_1) : null;
  const createdSessions: Array<{ cwd: string; opts: Record<string, unknown> }> = [];
  const sdkSend = vi.fn();
  const sdkClose = vi.fn(async () => {});
  const handle: ClaudeSessionLike = {
    send: sdkSend,
    abort: vi.fn(),
    respondPermission: vi.fn(),
    respondAsk: vi.fn(),
    respondElicitation: vi.fn(() => true),
    respondUserDialog: vi.fn(() => true),
    setFastMode: vi.fn(async () => {}),
    fastAutoModel: vi.fn(async () => undefined),
    runtimeInfo: vi.fn(() => ({})),
    close: sdkClose,
  };
  const contexts: TerminalStartContext[] = [];
  let exitCallback: ((exitCode: number | null, reason?: string) => void) | null = null;
  const runtimeStop = vi.fn(async () => {});
  const runtime: TerminalRuntimeHandle = {
    pid: 4321,
    backend: "windows-terminal",
    identity: { pid: 4321, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" },
    onExit: (callback) => { exitCallback = callback; },
    stop: runtimeStop,
  };
  const server = await startServer({
    config: { token: "tok", port: 0, allowedOrigins: [], createdAt: "" },
    sessions,
    aliases,
    configDir: dir,
    workspaceStore: new WorkspaceStore(path.join(dir, "workspace.json")),
    createSession: ((cwd: string, opts: Record<string, unknown>) => {
      createdSessions.push({ cwd, opts });
      return handle;
    }) as never,
    terminal: {
      privateDir: path.join(dir, "terminal"),
      resolveCli: () => cliPath,
      system: async (context) => {
        contexts.push(context);
        return runtime;
      },
    },
  });
  servers.push(server);
  const view = await connect(server.port);
  view.ws.send(JSON.stringify({ type: "client.ready" }));
  await view.inbox.waitFor("chat.sync");
  if (alias) {
    view.ws.send(JSON.stringify({ type: "alias.select", id: alias.id }));
  } else {
    view.ws.send(JSON.stringify({ type: "folder.bind", path: work }));
  }
  await view.inbox.waitWhere((message) => message.type === "folder.bound" && message.sessionId === SID_1, "绑定 SID_1");
  return {
    dir, work, cliPath, sessions, aliases, alias, server, view, contexts, createdSessions,
    sdkSend, sdkClose, runtimeStop,
    exit: (code: number | null) => exitCallback?.(code, "exit"),
  };
}

async function openTerminal(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const from = f.view.inbox.inbox.length;
  f.view.ws.send(JSON.stringify({ type: "terminal.open", mode: "system" }));
  const opened = await f.view.inbox.waitFor("terminal.opened", from);
  if (opened.type !== "terminal.opened") throw new Error("终端启动应答类型错误");
  return opened.leaseId;
}

async function postHook(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  source: "startup" | "resume" | "clear" | "compact" | "fork",
): Promise<void> {
  const context = f.contexts[0]!;
  const response = await fetch(`http://127.0.0.1:${f.server.port}/terminal-hook/${context.leaseId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${context.hookToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: f.work,
      transcript_path: transcriptFile(f.work, sessionId),
      source,
    }),
  });
  expect(response.status).toBe(200);
}

const RECOVERED_LEASE_ID = "55555555-5555-4555-8555-555555555555";

/** 预置私有系统 lease，启动真实 Server 验证重启后的只读与退出恢复。 */
async function recoveredFixture(options: { identityMatches: boolean; exitAlready?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-server-recovery-"));
  tempDirs.push(dir);
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude-config");
  const work = path.join(dir, "recovered work");
  fs.mkdirSync(work, { recursive: true });
  writeTranscript(work, SID_2, "终端里最后的会话");
  const sessions = new SessionManager(path.join(dir, "sessions.json"));
  sessions.set(work, { sessionId: SID_2, title: "最后会话", updatedAt: new Date().toISOString() });
  const aliases = new AliasManager(path.join(dir, "aliases.json"));
  const workspaceStore = new WorkspaceStore(path.join(dir, "workspace.json"));
  workspaceStore.save({ folder: work, aliasId: null });
  const privateDir = path.join(dir, "terminal");
  const identity = { pid: 5432, executable: "C:/bridge/ccc-bridge.exe", startedAt: "2026-11-10T08:00:00.000Z" };
  const record: TerminalLeaseRecord = {
    leaseId: RECOVERED_LEASE_ID,
    hookToken: "R".repeat(43),
    mode: "system",
    folder: work,
    initialSessionId: SID_1,
    resumeSessionId: SID_1,
    currentSessionId: SID_2,
    confirmedSessionId: SID_2,
    cliPath: "C:/fake-claude.exe",
    port: 19280,
    privateDir,
    phase: "active",
    backend: "windows-terminal",
    pid: identity.pid,
    identity,
    createdAt: "2026-11-10T08:00:00.000Z",
    canManualRelease: false,
  };
  const leaseFile = path.join(privateDir, "system-lease.json");
  new TerminalLeaseStore(leaseFile).save(record);
  if (options.exitAlready) {
    fs.writeFileSync(path.join(privateDir, `${record.leaseId}.exit.json`), JSON.stringify({
      leaseId: record.leaseId, exitCode: 0, reason: "exit",
    }), "utf8");
  }
  const createdSessions: Array<{ cwd: string; opts: Record<string, unknown> }> = [];
  const handle: ClaudeSessionLike = {
    send: vi.fn(), abort: vi.fn(), respondPermission: vi.fn(), respondAsk: vi.fn(),
    respondElicitation: vi.fn(() => true), respondUserDialog: vi.fn(() => true),
    setFastMode: vi.fn(async () => {}), fastAutoModel: vi.fn(async () => undefined),
    runtimeInfo: vi.fn(() => ({})), close: vi.fn(async () => {}),
  };
  const recover = vi.fn((saved: TerminalLeaseRecord): TerminalRuntimeHandle =>
    new SystemTerminalAdapter().recover(saved));
  const matchesIdentity = vi.fn(async () => options.identityMatches);
  const server = await startServer({
    config: { token: "tok", port: 0, allowedOrigins: [], createdAt: "" },
    sessions,
    aliases,
    configDir: dir,
    workspaceStore,
    createSession: ((cwd: string, opts: Record<string, unknown>) => {
      createdSessions.push({ cwd, opts });
      return handle;
    }) as never,
    terminal: {
      privateDir,
      system: async () => { throw new Error("恢复时不得重新打开终端"); },
      recover,
      matchesIdentity,
    },
  });
  servers.push(server);
  const view = await connect(server.port);
  view.ws.send(JSON.stringify({ type: "client.ready" }));
  await view.inbox.waitFor("chat.sync");
  return { dir, work, server, view, record, leaseFile, createdSessions, recover, matchesIdentity };
}

describe("系统终端生产 WS 接线", () => {
  it("接管后写请求全部 READ_ONLY，历史、草稿和快照仍可用", async () => {
    const f = await fixture();
    await openTerminal(f);
    expect(f.contexts[0]?.cliPath).toBe(f.cliPath);
    expect(f.sdkClose).toHaveBeenCalled();
    const writes = [
      { type: "chat.send", text: "不得双写" }, { type: "chat.abort" },
      { type: "session.new" }, { type: "session.switch", sessionId: SID_2 },
      { type: "session.delete", sessionId: SID_2 }, { type: "folder.bind", path: f.work },
      { type: "alias.select", id: "alias-1" }, { type: "alias.delete", id: "alias-1" },
      { type: "permission.response", requestId: "p1", allow: true },
      { type: "chat.ask.answer", requestId: "a1", answers: {} },
      { type: "settings.set", permissionMode: "plan", effort: "medium", fastMode: false },
    ];
    for (const message of writes) f.view.ws.send(JSON.stringify(message));
    await f.view.inbox.waitWhere(() => f.view.inbox.inbox.filter((message) =>
      message.type === "terminal.error" && message.code === "READ_ONLY").length === writes.length, "11 个只读拒绝");
    expect(f.sdkSend).not.toHaveBeenCalled();
    f.view.ws.send(JSON.stringify({ type: "session.history", limit: 10 }));
    await f.view.inbox.waitFor("session.history.data");
    f.view.ws.send(JSON.stringify({ type: "chat.draft", text: "保留草稿" }));
    const from = f.view.inbox.inbox.length;
    f.view.ws.send(JSON.stringify({ type: "client.ready" }));
    const sync = await f.view.inbox.waitFor("chat.sync", from);
    expect(sync).toMatchObject({ type: "chat.sync", draft: "保留草稿" });
    expect(f.view.inbox.inbox.slice(from).some((message) =>
      message.type === "terminal.state" && message.state.phase === "starting")).toBe(true);
  });

  it("普通新文件只刷新列表，有效 Hook 才更新当前会话和别名", async () => {
    const f = await fixture(true);
    await openTerminal(f);
    writeTranscript(f.work, SID_2, "普通终端的新会话");
    await f.view.inbox.waitWhere((message) => message.type === "session.list.data"
      && message.sessions.some((session) => session.sessionId === SID_2), "发现 SID_2");
    expect(f.sessions.get(f.work)?.sessionId).toBe(SID_1);
    await postHook(f, SID_2, "clear");
    await f.view.inbox.waitWhere((message) => message.type === "folder.bound"
      && message.sessionId === SID_2 && message.reset === true, "Hook 切换 SID_2");
    expect(f.sessions.get(f.work)?.sessionId).toBe(SID_2);
    expect(f.aliases.get(f.alias!.id)?.sessionId).toBe(SID_2);
    await postHook(f, SID_2, "compact");
    expect(f.sessions.get(f.work)?.sessionId).toBe(SID_2);
  });

  it("非 owner 不能关闭；真实退出先最终镜像再恢复最后 Hook 会话", async () => {
    const f = await fixture();
    const leaseId = await openTerminal(f);
    await postHook(f, SID_1, "resume");
    await postHook(f, SID_2, "clear");
    const second = await connect(f.server.port);
    second.ws.send(JSON.stringify({ type: "client.ready" }));
    await second.inbox.waitFor("chat.sync");
    second.ws.send(JSON.stringify({ type: "terminal.close", leaseId }));
    expect(await second.inbox.waitFor("terminal.error")).toMatchObject({ code: "NOT_OWNER" });
    expect(f.runtimeStop).not.toHaveBeenCalled();
    const from = f.view.inbox.inbox.length;
    f.view.ws.send(JSON.stringify({ type: "terminal.close", leaseId }));
    await f.view.inbox.waitFor("terminal.state", from);
    expect(f.runtimeStop).toHaveBeenCalledOnce();
    f.exit(0);
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle" && f.view.inbox.inbox.indexOf(message) >= from, "owner 收到 idle");
    await second.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "第二视图收到 idle");
    const tail = f.view.inbox.inbox.slice(from);
    const mirrorIndex = tail.map((message) => message.type === "session.mirror.data").lastIndexOf(true);
    const restoreIndex = tail.map((message) => message.type === "folder.bound" && message.sessionId === SID_2).lastIndexOf(true);
    const idleIndex = tail.map((message) => message.type === "terminal.state" && message.state.phase === "idle").lastIndexOf(true);
    expect(mirrorIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(mirrorIndex);
    expect(idleIndex).toBeGreaterThan(restoreIndex);
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
  });

  it("活动 lease 原子保存并在真实退出后按同一 leaseId 清除", async () => {
    const f = await fixture();
    const leaseId = await openTerminal(f);
    const leaseFile = path.join(f.dir, "terminal", "system-lease.json");
    expect(fs.existsSync(leaseFile)).toBe(true);
    await postHook(f, SID_2, "clear");
    expect(new TerminalLeaseStore(leaseFile).load()).toMatchObject({
      leaseId, currentSessionId: SID_2, confirmedSessionId: SID_2, phase: "active",
    });
    f.exit(0);
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "退出后 idle");
    expect(fs.existsSync(leaseFile)).toBe(false);
  });
});

describe("系统终端桥接重启恢复", () => {
  it("身份三项匹配时恢复只读，人工解除仍要求 unknown 状态", async () => {
    const f = await recoveredFixture({ identityMatches: true });
    expect(f.matchesIdentity).toHaveBeenCalledWith(f.record.identity);
    expect(f.recover).toHaveBeenCalledOnce();
    const state = f.view.inbox.inbox.find((message) => message.type === "terminal.state");
    expect(state).toMatchObject({
      type: "terminal.state",
      state: { leaseId: RECOVERED_LEASE_ID, phase: "active", currentSessionId: SID_2, canManualRelease: false },
    });
    expect(f.createdSessions).toHaveLength(0);
    f.view.ws.send(JSON.stringify({ type: "chat.send", text: "不得恢复双写" }));
    await f.view.inbox.waitWhere((message) => message.type === "terminal.error" && message.code === "READ_ONLY", "恢复后只读");
    f.view.ws.send(JSON.stringify({ type: "terminal.release", leaseId: RECOVERED_LEASE_ID, confirmedClosed: true }));
    await f.view.inbox.waitWhere((message) => message.type === "terminal.error" && message.code === "CONFIRM_REQUIRED", "活 lease 不得人工解除");
    expect(fs.existsSync(f.leaseFile)).toBe(true);
  });

  it("重启前 exit.json 已存在时先最终镜像再恢复最后 Hook 会话", async () => {
    const f = await recoveredFixture({ identityMatches: false, exitAlready: true });
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "已退出 lease 清理");
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.matchesIdentity).not.toHaveBeenCalled();
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    expect(fs.existsSync(f.leaseFile)).toBe(false);
    const types = f.view.inbox.inbox.map((message) => message.type);
    expect(types.lastIndexOf("session.mirror.data")).toBeLessThan(types.lastIndexOf("folder.bound"));
    expect(types.lastIndexOf("folder.bound")).toBeLessThan(types.lastIndexOf("terminal.state"));
  });

  it("身份 unknown 保持只读，明确确认后恢复且绝不写停止文件", async () => {
    const f = await recoveredFixture({ identityMatches: false });
    expect(f.recover).not.toHaveBeenCalled();
    const state = f.view.inbox.inbox.find((message) => message.type === "terminal.state");
    expect(state).toMatchObject({
      type: "terminal.state",
      state: { leaseId: RECOVERED_LEASE_ID, currentSessionId: SID_2, canManualRelease: true },
    });
    expect(f.createdSessions).toHaveLength(0);
    f.view.ws.send(JSON.stringify({ type: "terminal.release", leaseId: RECOVERED_LEASE_ID, confirmedClosed: false }));
    f.view.ws.send(JSON.stringify({ type: "chat.send", text: "未确认仍只读" }));
    await f.view.inbox.waitWhere((message) => message.type === "terminal.error" && message.code === "READ_ONLY", "未确认不得清 lease");
    expect(fs.existsSync(f.leaseFile)).toBe(true);
    f.view.ws.send(JSON.stringify({ type: "terminal.release", leaseId: RECOVERED_LEASE_ID, confirmedClosed: true }));
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "确认后恢复输入");
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    expect(fs.existsSync(path.join(f.dir, "terminal", `${RECOVERED_LEASE_ID}.stop`))).toBe(false);
    expect(fs.existsSync(f.leaseFile)).toBe(false);
  });
});
