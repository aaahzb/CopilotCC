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
import type { PtyBackend, PtyExitEvent, PtyProcess, PtySpawnOptions } from "../src/pty-backend";
import { EmbeddedTerminalAdapter } from "../src/embedded-terminal";
import { TerminalLeaseStore } from "../src/terminal-store";
import type { TerminalLeaseRecord } from "../src/terminal-lease";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";
const tempDirs: string[] = [];
const servers: StartedServer[] = [];
const sockets: WebSocket[] = [];
const fakePtys: FakePty[] = [];
let previousConfigDir: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  for (const ws of sockets.splice(0)) ws.close();
  // kill 的 Promise 不代表进程退出；夹具清理必须显式驱动真实退出回调，避免关闭屏障等待假进程。
  for (const pty of fakePtys.splice(0)) pty.emitExit(0);
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

/** 收集真实 WS 帧，并支持只观察某个动作之后的新消息。 */
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

/** 建立完成 token 握手的真实本机连接。 */
async function connect(port: number): Promise<{ ws: WebSocket; inbox: Collector }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, inbox: collect(ws) };
}

/** 返回指定工作区的隔离转录路径。 */
function transcriptFile(work: string, sessionId: string): string {
  return path.join(transcriptProjectsRoot(), slugifyPath(path.resolve(work)), `${sessionId}.jsonl`);
}

/** 写入一条最小真实用户转录，供最终镜像和会话恢复读取。 */
function writeTranscript(work: string, sessionId: string, text: string): void {
  const file = transcriptFile(work, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    type: "user", uuid: `uuid-${sessionId}`, timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  })}\n`, "utf8");
}

/** 可控 PTY：测试显式驱动输出和退出，kill 不伪造进程退出。 */
class FakePty implements PtyProcess {
  readonly pid = 4321;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn(async () => {});
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: PtyExitEvent) => void) | null = null;
  earlyExitCode: number | null = null;

  onData(callback: (data: string) => void): void { this.dataCallback = callback; }
  onExit(callback: (event: PtyExitEvent) => void): void {
    this.exitCallback = callback;
    if (this.earlyExitCode !== null) callback({ exitCode: this.earlyExitCode, signal: null });
  }
  emitData(data: string): void { this.dataCallback?.(data); }
  emitExit(exitCode: number): void { this.exitCallback?.({ exitCode, signal: null }); }
}

/** 启动真实 Server 和 EmbeddedTerminalAdapter，仅原生 PTY 层使用替身。 */
async function fixture(options: { spawnError?: string; tinyBuffer?: boolean; earlyExitCode?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-server-embedded-"));
  tempDirs.push(dir);
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude-config");
  const work = path.join(dir, "work with space");
  const cliPath = path.join(dir, process.platform === "win32" ? "fake-claude.exe" : "fake-claude");
  fs.mkdirSync(work, { recursive: true });
  writeTranscript(work, SID_1, "初始会话");
  writeTranscript(work, SID_2, "终端新会话");
  const sessions = new SessionManager(path.join(dir, "sessions.json"));
  sessions.set(work, { sessionId: SID_1, title: "初始会话", updatedAt: new Date().toISOString() });
  const aliases = new AliasManager(path.join(dir, "aliases.json"));
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
  const pty = new FakePty();
  fakePtys.push(pty);
  if (options.earlyExitCode !== undefined) pty.earlyExitCode = options.earlyExitCode;
  const spawn = vi.fn(async (_spawnOptions: PtySpawnOptions): Promise<PtyProcess> => {
    if (options.spawnError) throw new Error(options.spawnError);
    return pty;
  });
  const backend: PtyBackend = { kind: "bun-node-pty", spawn, close: vi.fn(async () => {}) };
  const embedded = new EmbeddedTerminalAdapter({
    backend,
    probeVersion: async () => "2.1.316",
    childCommand: { executable: "C:/bridge/ccc-terminal.exe", prefixArgs: [] },
    readIdentity: async () => ({
      pid: 4321, executable: "C:/fake/claude.exe", startedAt: "2026-11-10T08:00:00.000Z",
    }),
    ...(options.tinyBuffer ? { bufferLimits: { maxBytes: 8, maxChunks: 8 } } : {}),
  });
  const systemStart = vi.fn(async () => ({
    pid: 9876,
    backend: "windows-terminal" as const,
    onExit: vi.fn(),
    stop: vi.fn(async () => {}),
  }));
  let startContext: Parameters<EmbeddedTerminalAdapter["start"]>[0] | null = null;
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
      system: systemStart,
      embedded: (context) => {
        startContext = context;
        return embedded.start(context);
      },
    },
  });
  servers.push(server);
  const view = await connect(server.port);
  view.ws.send(JSON.stringify({ type: "client.ready" }));
  await view.inbox.waitFor("chat.sync");
  view.ws.send(JSON.stringify({ type: "folder.bind", path: work }));
  await view.inbox.waitWhere((message) => message.type === "folder.bound" && message.sessionId === SID_1, "绑定 SID_1");
  return {
    dir, work, cliPath, sessions, server, view, createdSessions, sdkSend, sdkClose, pty, spawn, systemStart,
    get startContext() {
      if (!startContext) throw new Error("embedded 尚未启动");
      return startContext;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Opened = Extract<ServerMessage, { type: "terminal.opened" }> & { attachToken: string };

/** 打开 embedded 并收窄出只应定向出现的 attachToken。 */
async function openEmbedded(f: Fixture, connection = f.view): Promise<Opened> {
  const from = connection.inbox.inbox.length;
  connection.ws.send(JSON.stringify({ type: "terminal.open", mode: "embedded" }));
  const opened = await connection.inbox.waitFor("terminal.opened", from) as Opened;
  expect(opened.attachToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return opened;
}

/** 用指定连接和游标绑定终端。 */
function attach(connection: { ws: WebSocket }, opened: Opened, afterSeq = 0): void {
  connection.ws.send(JSON.stringify({
    type: "terminal.attach", leaseId: opened.leaseId, attachToken: opened.attachToken, afterSeq,
  }));
}

/** 完成初次 attach 的夹具。 */
async function attachedFixture(options: { tinyBuffer?: boolean } = {}) {
  const f = await fixture(options);
  const opened = await openEmbedded(f);
  attach(f.view, opened);
  await f.view.inbox.waitFor("terminal.attached");
  return { ...f, opened };
}

/** 发送当前 lease 的合法 SessionStart Hook。 */
async function postHook(f: Fixture, leaseId: string, sessionId: string, source: "resume" | "clear"): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${f.server.port}/terminal-hook/${leaseId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.startContext.hookToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      hook_event_name: "SessionStart", session_id: sessionId, cwd: f.work,
      transcript_path: transcriptFile(f.work, sessionId), source,
    }),
  });
  expect(response.status).toBe(200);
}

const RECOVERED_LEASE_ID = "55555555-5555-4555-8555-555555555555";

/** 预置 embedded 私有 lease，验证桥接异常重启后的保守清理。 */
async function recoveredEmbeddedFixture(options: {
  identityMatches: boolean;
  exitAlready?: boolean;
  processAlive?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-server-embedded-recovery-"));
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
  const identity = { pid: 5432, executable: "C:/fake/claude.exe", startedAt: "2026-11-10T08:00:00.000Z" };
  const record: TerminalLeaseRecord = {
    leaseId: RECOVERED_LEASE_ID,
    hookToken: "R".repeat(43),
    mode: "embedded",
    folder: work,
    initialSessionId: SID_1,
    resumeSessionId: SID_1,
    currentSessionId: SID_2,
    confirmedSessionId: SID_2,
    cliPath: "C:/fake/claude.exe",
    port: 19280,
    privateDir,
    phase: "active",
    backend: "pty",
    pid: identity.pid,
    identity,
    createdAt: "2026-11-10T08:00:00.000Z",
    canManualRelease: false,
  };
  const leaseFile = path.join(privateDir, "embedded-lease.json");
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
  const recoverEmbedded = vi.fn(async () => {});
  const matchesIdentity = vi.fn(async () => options.identityMatches);
  const isProcessAlive = vi.fn(() => options.processAlive ?? true);
  const embeddedStart = vi.fn(async () => { throw new Error("恢复时不得重新打开 PTY"); });
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
      system: async () => { throw new Error("恢复时不得打开系统终端"); },
      embedded: embeddedStart,
      recoverEmbedded,
      matchesIdentity,
      isProcessAlive,
    },
  });
  servers.push(server);
  const view = await connect(server.port);
  view.ws.send(JSON.stringify({ type: "client.ready" }));
  await view.inbox.waitFor("chat.sync");
  return {
    server, view, record, leaseFile, createdSessions, recoverEmbedded, matchesIdentity, isProcessAlive, embeddedStart,
  };
}

describe("内嵌终端真实 WS 服务接线", () => {
  it("opened 前输出只入缓冲，attachToken 不广播；attach 顺序固定且非 owner 被拒绝", async () => {
    const f = await fixture();
    const other = await connect(f.server.port);
    const opened = await openEmbedded(f);
    expect(f.spawn.mock.calls[0]?.[0].args.slice(0, 2)).toEqual(["--resume", SID_1]);
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({ file: f.cliPath, cwd: f.work, cols: 120, rows: 32 });
    const saved = new TerminalLeaseStore(path.join(f.dir, "terminal", "embedded-lease.json")).load();
    expect(saved?.identity).toEqual({
      pid: 4321, executable: "C:/fake/claude.exe", startedAt: "2026-11-10T08:00:00.000Z",
    });
    expect(other.inbox.inbox.some((message) => message.type === "terminal.opened"
      || (message.type === "terminal.state" && JSON.stringify(message).includes(opened.attachToken)))).toBe(false);
    f.pty.emitData("before attach");
    expect(f.view.inbox.inbox.filter((message) => message.type === "terminal.output")).toHaveLength(0);
    attach(other, opened);
    expect(await other.inbox.waitFor("terminal.error")).toMatchObject({ code: "NOT_OWNER" });
    attach(f.view, opened);
    const attached = await f.view.inbox.waitFor("terminal.attached");
    const output = await f.view.inbox.waitFor("terminal.output");
    expect(attached).toMatchObject({ leaseId: opened.leaseId, replayGap: false, latestSeq: 1 });
    expect(output).toMatchObject({ leaseId: opened.leaseId, seq: 1, data: "before attach" });
    expect(f.view.inbox.inbox.indexOf(attached)).toBeLessThan(f.view.inbox.inbox.indexOf(output));
    expect(other.inbox.inbox.filter((message) => message.type === "terminal.output")).toHaveLength(0);
  });

  it("input/resize 只接受 attached owner，普通聊天连接断开不影响 PTY", async () => {
    const f = await attachedFixture();
    const other = await connect(f.server.port);
    other.ws.send(JSON.stringify({ type: "terminal.input", leaseId: f.opened.leaseId, data: "bad" }));
    other.ws.send(JSON.stringify({ type: "terminal.resize", leaseId: f.opened.leaseId, cols: 132, rows: 36 }));
    await other.inbox.waitWhere(() => other.inbox.inbox.filter((message) =>
      message.type === "terminal.error" && message.code === "ATTACH_REQUIRED").length === 2, "两次非法控制拒绝");
    expect(f.pty.write).not.toHaveBeenCalled();
    expect(f.pty.resize).not.toHaveBeenCalled();
    f.view.ws.send(JSON.stringify({ type: "terminal.input", leaseId: f.opened.leaseId, data: "中文\r" }));
    f.view.ws.send(JSON.stringify({ type: "terminal.resize", leaseId: f.opened.leaseId, cols: 132, rows: 36 }));
    await vi.waitFor(() => {
      expect(f.pty.write).toHaveBeenCalledWith("中文\r");
      expect(f.pty.resize).toHaveBeenCalledWith(132, 36);
    });
    other.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.pty.kill).not.toHaveBeenCalled();
  });

  it("owner 断开后原 token 新连接补齐缺口，错误 token 和全新页面不能续接", async () => {
    const f = await attachedFixture();
    f.pty.emitData("online");
    f.view.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.pty.emitData("offline");
    const reconnected = await connect(f.server.port);
    attach(reconnected, f.opened, 0);
    expect(await reconnected.inbox.waitFor("terminal.output")).toMatchObject({ seq: 1, data: "online" });
    attach(reconnected, f.opened, 1);
    const attached = await reconnected.inbox.waitWhere((message) => message.type === "terminal.attached"
      && message.latestSeq === 2, "断线后的 second attached");
    expect(attached).toMatchObject({ replayGap: false, latestSeq: 2 });
    expect(await reconnected.inbox.waitWhere((message) => message.type === "terminal.output"
      && message.seq === 2, "重放 offline")).toMatchObject({ seq: 2, data: "offline" });
    reconnected.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const wrongToken = await connect(f.server.port);
    attach(wrongToken, { ...f.opened, attachToken: "B".repeat(43) }, 2);
    expect(await wrongToken.inbox.waitFor("terminal.error")).toMatchObject({ code: "NOT_OWNER" });
    expect(f.pty.kill).not.toHaveBeenCalled();
  });

  it("重连超时 kill，最终镜像后恢复最后 Hook 会话并回到 idle", async () => {
    const f = await attachedFixture();
    await postHook(f, f.opened.leaseId, SID_1, "resume");
    await postHook(f, f.opened.leaseId, SID_2, "clear");
    const control = await connect(f.server.port);
    const from = control.inbox.inbox.length;
    f.view.ws.close();
    await vi.waitFor(() => expect(f.pty.kill).toHaveBeenCalledTimes(1), { timeout: 4500, interval: 30 });
    f.pty.emitExit(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, "terminal", `${f.opened.leaseId}.exit.json`), "utf8")))
      .toMatchObject({ leaseId: f.opened.leaseId, exitCode: 0, reason: "exit" });
    await control.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle" && control.inbox.inbox.indexOf(message) >= from, "退出后 idle");
    const tail = control.inbox.inbox.slice(from);
    const mirrorIndex = tail.map((message) => message.type === "session.mirror.data").lastIndexOf(true);
    const restoreIndex = tail.map((message) => message.type === "folder.bound" && message.sessionId === SID_2).lastIndexOf(true);
    const idleIndex = tail.map((message) => message.type === "terminal.state" && message.state.phase === "idle").lastIndexOf(true);
    expect(mirrorIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(mirrorIndex);
    expect(idleIndex).toBeGreaterThan(restoreIndex);
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    const fresh = await connect(f.server.port);
    const next = await openEmbedded(f, fresh);
    expect(next.attachToken).not.toBe(f.opened.attachToken);
  });

  it("PTY 在启动返回前退出也不丢失退出事件，lease 最终恢复", async () => {
    const f = await fixture({ earlyExitCode: 9 });
    const from = f.view.inbox.inbox.length;
    f.view.ws.send(JSON.stringify({ type: "terminal.open", mode: "embedded" }));
    await f.view.inbox.waitFor("terminal.error", from);
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle" && f.view.inbox.inbox.indexOf(message) >= from, "启动即退出后的 idle");
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_1);
  });

  it("重放缺口发 OUTPUT_GAP 并结束，不发送伪造连续数据", async () => {
    const f = await attachedFixture({ tinyBuffer: true });
    f.pty.emitData("1111");
    f.pty.emitData("2222");
    f.pty.emitData("3333");
    f.view.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reconnected = await connect(f.server.port);
    attach(reconnected, f.opened, 0);
    expect(await reconnected.inbox.waitFor("terminal.attached")).toMatchObject({ replayGap: true });
    expect(await reconnected.inbox.waitFor("terminal.error")).toMatchObject({ code: "OUTPUT_GAP" });
    expect(f.pty.kill).toHaveBeenCalledTimes(1);
    f.pty.emitData("late output must not appear");
    expect(reconnected.inbox.inbox.filter((message) => message.type === "terminal.output")).toHaveLength(0);
  });

  it("桥接正常关闭等待真实 PTY 退出和 lease 最终清理后才完成", async () => {
    const f = await attachedFixture();
    await postHook(f, f.opened.leaseId, SID_2, "clear");
    const control = await connect(f.server.port);
    const from = control.inbox.inbox.length;
    const leaseFile = path.join(f.dir, "terminal", "embedded-lease.json");
    let closed = false;
    const closing = f.server.close().then(() => { closed = true; });

    await vi.waitFor(() => expect(f.pty.kill).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false); // kill 已返回但真实 exit 未发生，不能提前结束桥接关闭。
    expect(fs.existsSync(leaseFile)).toBe(true);

    f.pty.emitExit(0);
    await closing;
    expect(closed).toBe(true);
    expect(fs.existsSync(leaseFile)).toBe(false);
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    const tail = control.inbox.inbox.slice(from);
    const mirrorIndex = tail.map((message) => message.type === "session.mirror.data"
      && message.sessionId === SID_2).lastIndexOf(true);
    const restoreIndex = tail.map((message) => message.type === "folder.bound"
      && message.sessionId === SID_2).lastIndexOf(true);
    const idleIndex = tail.map((message) => message.type === "terminal.state"
      && message.state.phase === "idle").lastIndexOf(true);
    expect(mirrorIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(mirrorIndex);
    expect(idleIndex).toBeGreaterThan(restoreIndex);
  });

  it("PTY_UNAVAILABLE 只定向终端页，聊天恢复且系统终端仍可用", async () => {
    const f = await fixture({ spawnError: "PTY_UNAVAILABLE" });
    const other = await connect(f.server.port);
    const from = f.view.inbox.inbox.length;
    f.view.ws.send(JSON.stringify({ type: "terminal.open", mode: "embedded" }));
    expect(await f.view.inbox.waitFor("terminal.error", from)).toMatchObject({ code: "PTY_UNAVAILABLE" });
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle" && f.view.inbox.inbox.indexOf(message) >= from, "失败后 idle");
    expect(other.inbox.inbox.filter((message) => message.type === "terminal.error")).toHaveLength(0);
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_1);
    f.view.ws.send(JSON.stringify({ type: "terminal.open", mode: "system" }));
    expect(await f.view.inbox.waitFor("terminal.opened", from)).toMatchObject({ mode: "system" });
    expect(f.systemStart).toHaveBeenCalledTimes(1);
  });

  it("PTY 失败后普通聊天不受 READ_ONLY 影响", async () => {
    const f = await fixture({ spawnError: "PTY_UNAVAILABLE" });
    const from = f.view.inbox.inbox.length;
    f.view.ws.send(JSON.stringify({ type: "terminal.open", mode: "embedded" }));
    expect(await f.view.inbox.waitFor("terminal.error", from)).toMatchObject({ code: "PTY_UNAVAILABLE" });
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle" && f.view.inbox.inbox.indexOf(message) >= from, "失败后 idle");
    f.view.ws.send(JSON.stringify({ type: "chat.send", text: "普通聊天仍可用" }));
    await vi.waitFor(() => expect(f.sdkSend).toHaveBeenCalledWith("普通聊天仍可用"));
    expect(f.systemStart).not.toHaveBeenCalled();
  });
});

describe("内嵌终端异常重启恢复", () => {
  it("身份三项完全匹配才清理遗留 PID，随后最终镜像并恢复", async () => {
    const f = await recoveredEmbeddedFixture({ identityMatches: true });
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "匹配身份清理后 idle");
    expect(f.matchesIdentity).toHaveBeenCalledWith(f.record.identity);
    expect(f.recoverEmbedded).toHaveBeenCalledOnce();
    expect(f.embeddedStart).not.toHaveBeenCalled();
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    expect(fs.existsSync(f.leaseFile)).toBe(false);
    const types = f.view.inbox.inbox.map((message) => message.type);
    expect(types.lastIndexOf("session.mirror.data")).toBeLessThan(types.lastIndexOf("folder.bound"));
    expect(types.lastIndexOf("folder.bound")).toBeLessThan(types.lastIndexOf("terminal.state"));
  });

  it("重启前真实 exit 文件已存在时不查身份、不杀 PID，直接最终同步", async () => {
    const f = await recoveredEmbeddedFixture({ identityMatches: false, exitAlready: true });
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "退出记录清理后 idle");
    expect(f.matchesIdentity).not.toHaveBeenCalled();
    expect(f.recoverEmbedded).not.toHaveBeenCalled();
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    expect(fs.existsSync(f.leaseFile)).toBe(false);
  });

  it("ConPTY 随异常桥接退出且 PID 已不存在时直接最终同步", async () => {
    const f = await recoveredEmbeddedFixture({ identityMatches: false, processAlive: false });
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "确认进程退出后 idle");
    expect(f.isProcessAlive).toHaveBeenCalledWith(f.record.pid);
    expect(f.matchesIdentity).not.toHaveBeenCalled();
    expect(f.recoverEmbedded).not.toHaveBeenCalled();
    expect(f.embeddedStart).not.toHaveBeenCalled();
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    expect(fs.existsSync(f.leaseFile)).toBe(false);
  });

  it("身份 unknown 保持只读，人工确认只恢复 SDK，绝不清理旧 PID", async () => {
    const f = await recoveredEmbeddedFixture({ identityMatches: false });
    expect(f.recoverEmbedded).not.toHaveBeenCalled();
    expect(f.embeddedStart).not.toHaveBeenCalled();
    const state = f.view.inbox.inbox.find((message) => message.type === "terminal.state");
    expect(state).toMatchObject({
      type: "terminal.state",
      state: { leaseId: RECOVERED_LEASE_ID, mode: "embedded", currentSessionId: SID_2, canManualRelease: true },
    });
    f.view.ws.send(JSON.stringify({ type: "chat.send", text: "不得恢复双写" }));
    await f.view.inbox.waitWhere((message) => message.type === "terminal.error" && message.code === "READ_ONLY", "恢复后只读");
    f.view.ws.send(JSON.stringify({ type: "terminal.release", leaseId: RECOVERED_LEASE_ID, confirmedClosed: true }));
    await f.view.inbox.waitWhere((message) => message.type === "terminal.state"
      && message.state.phase === "idle", "确认后恢复输入");
    expect(f.recoverEmbedded).not.toHaveBeenCalled();
    expect(f.createdSessions.at(-1)?.opts.resumeId).toBe(SID_2);
    expect(fs.existsSync(f.leaseFile)).toBe(false);
  });
});
