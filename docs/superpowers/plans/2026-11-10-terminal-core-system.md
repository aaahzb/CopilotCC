# Terminal Core and System Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付系统终端续聊、准确会话跟随、普通终端会话发现、聊天只读镜像和退出恢复，为后续内嵌 PTY 终端提供同一套 lease/hooks/watcher 核心。

**Architecture:** `TerminalLeaseManager` 独占工作区写入权，系统终端适配器只负责可见窗口和私有包装进程；CLI 通过每次 lease 独立的 Session Hooks 报告真实 sessionId，传输方式必须由真实探针确认，当前生产固定使用 command helper，常驻 `TranscriptWatcher` 只发现文件和触发结构化镜像。聊天视图继续使用 `readTranscriptPage` 和稳定 ID，不解析 ANSI，也不按最新 mtime 猜当前会话。

**Tech Stack:** TypeScript、Node.js 22、Bun 单文件 exe、Chrome MV3、React 19、Vitest、Claude Code JSONL/HTTP Hooks。

## Global Constraints

- 仅支持 Windows x64（Windows 10 1809+）和 macOS arm64；Linux、Windows x86、macOS Intel 不在范围内。
- Windows 优先 Windows Terminal，缺失时回退可见系统控制台；macOS 使用 Terminal.app；GUI 子进程必须 `windowsHide: false`。
- 有会话用 `claude --resume <sessionId>`；无会话由桥接生成 UUID 并用 `claude --session-id <uuid>`。
- 不修改全局 Claude 设置；每次终端使用 `CCC_BRIDGE_HOME` 下的私有 `--settings` 文件和独立 hook token。
- 不依赖 Remote Control、官方 Anthropic 登录或云端服务；真实验收只使用本机假 CLI/假上游，不调用真实 API。
- 不读取或打印 `config.json`、API key、hook token、配对串或完整进程环境。
- 不停止或替换用户正在使用的桥接；编译产物在项目树外、隔离 CWD、`CCC_BRIDGE_HOME` 和 `CLAUDE_CONFIG_DIR` 中验证。
- 验证目录只能建在 `D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110`。
- 所有写文件使用 UTF-8；修改已有文件前必须按用户规则取得明确确认；本计划本身不授权修改生产文件。
- 不自动 commit、push、tag 或发布。下面的提交命令只有在用户单独授权后才能执行；提交作者和提交者只能是 `aaahzb` 本人的 Git 身份，禁止任何共同作者尾注。
- 每步先取得预期原因的 RED，再写最小实现取得 GREEN；新测试若直接通过，先修正测试，不能把它计为 TDD。
- 阶段 A 完成不代表双终端需求完成；内嵌终端由 `2026-11-10-embedded-terminal.md` 继续交付。

---

## File Map

- Create `bridge/src/terminal-lease.ts`：lease 状态机、公开状态脱敏、hook 会话确认和退出恢复事件。
- Create `bridge/src/terminal-store.ts`：系统 lease 的原子持久化和恢复记录校验。
- Create `bridge/src/terminal-hooks.ts`：私有 settings、64 KiB Hook 请求解析、token/cwd/transcript 归属校验。
- Create `bridge/src/cli-capabilities.ts`：无 API 的 CLI 版本探测与 Hook transport 选择。
- Create `bridge/src/terminal-hook-helper.ts`：旧 CLI command Hook 的 stdin→回环 HTTP 转发，与 HTTP Hook 共用校验。
- Create `bridge/scripts/probe-cli-hooks.mjs`：真实 CLI + 本机假上游的 SessionStart Hook 能力探针。
- Create `bridge/src/transcript-watcher.ts`：250 ms 防抖、2 秒对账、绑定/解绑。
- Create `bridge/src/process-identity.ts`：PID、程序路径和进程启动时间的严格核对。
- Create `bridge/src/terminal-child.ts`：私有包装进程，启动 CLI、继承环境、写退出状态、响应停止文件。
- Create `bridge/src/runtime-entry.ts`：区分 tsx 开发入口与编译桥接 exe 的私有包装命令。
- Create `bridge/src/system-terminal.ts`：Windows Terminal、可见控制台和 Terminal.app 启动。
- Create `bridge/src/terminal-service.ts`：连接 lease、SDK 停机/恢复、watcher、镜像 revision 和系统适配器。
- Modify `bridge/src/claude-session.ts`：导出已有 CLI 路径解析和 shell 环境补齐，不复制解析逻辑。
- Modify `bridge/src/server.ts`：HTTP Hook 路由、WS 分发、写保护、快照和服务关闭。
- Modify `bridge/src/index.ts`、`bridge/src/tray.ts`：生产依赖装配与 `--terminal-child` 分发。
- Modify `shared/protocol.ts`，运行 `scripts/sync-protocol.mjs` 更新两份生成复制件。
- Create `extension/src/lib/terminal-mirror.ts`：sessionId/revision 防旧包、最新页 upsert、旧分页保留。
- Modify `extension/src/entrypoints/sidepanel/App.tsx` 和相关组件：系统终端入口、只读状态、错误和镜像。
- Tests 与生产文件一一对应；真实验收脚本放在 `bridge/scripts/verify-system-terminal.mjs`，记录写入已批准的验证根目录。

---

### Task 1: 共享协议与严格帧解析

**Files:**
- Modify: `shared/protocol.ts:163-340,450-600`
- Modify: `bridge/tests/protocol.test.ts`
- Generate: `bridge/src/protocol.ts`, `extension/src/lib/protocol.ts`

**Interfaces:**
- Produces: `TerminalMode`、`TerminalPhase`、`TerminalPublicState`、`TerminalErrorCode` 和 `session.mirror.data`。
- `terminal.open` 只允许 `{ type, mode: "system" | "embedded" }`，路径、sessionId 和命令字段一律不进入返回对象。
- `terminal.release` 必须显式携带 `confirmedClosed: true`，只用于重启后身份无法确认的人工解除，不用于杀进程。

- [ ] **Step 1: 写失败测试**

在 `bridge/tests/protocol.test.ts` 添加：

```ts
import { randomUUID } from "node:crypto";

describe("终端协议", () => {
  it("只接受模式，剥离路径、会话和命令注入字段", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "terminal.open", mode: "system", path: "D:/other",
      sessionId: "attacker", command: "calc.exe",
    }))).toEqual({ type: "terminal.open", mode: "system" });
    expect(parseClientMessage(JSON.stringify({ type: "terminal.open", mode: "bad" }))).toBeNull();
  });

  it("关闭要求 leaseId，人工解除要求明确确认", () => {
    const leaseId = randomUUID();
    expect(parseClientMessage(JSON.stringify({ type: "terminal.close", leaseId })))
      .toEqual({ type: "terminal.close", leaseId });
    expect(parseClientMessage(JSON.stringify({ type: "terminal.release", leaseId }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({
      type: "terminal.release", leaseId, confirmedClosed: true,
    }))).toEqual({ type: "terminal.release", leaseId, confirmedClosed: true });
  });

  it("公开状态和镜像可以编码且不包含 hookToken", () => {
    const state = {
      type: "terminal.state" as const,
      state: {
        leaseId: randomUUID(), mode: "system" as const, phase: "active" as const,
        folder: "D:/notes", initialSessionId: randomUUID(), currentSessionId: randomUUID(),
        backend: "windows-terminal" as const, canManualRelease: false,
      },
    };
    expect(JSON.parse(encode(state))).toEqual(state);
    expect(JSON.stringify(state)).not.toContain("hookToken");
  });
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/protocol.test.ts`
Expected: FAIL，提示 `terminal.open`/`terminal.close` 返回 `null`，且 `terminal.state` 类型不存在。

- [ ] **Step 3: 添加共享类型与解析分支**

在 `SessionInfo` 后加入以下完整类型，并把它们加入 `ClientMessage`/`ServerMessage` 联合：

```ts
export type TerminalMode = "system" | "embedded";
export type TerminalPhase = "idle" | "starting" | "active" | "degraded" | "stopping";
export type TerminalBackend = "windows-terminal" | "windows-console" | "terminal-app" | "pty";
export type TerminalErrorCode =
  | "NO_FOLDER" | "WORKSPACE_BUSY" | "ALREADY_ACTIVE" | "CLI_NOT_FOUND"
  | "START_FAILED" | "NOT_OWNER" | "NOT_FOUND" | "READ_ONLY"
  | "HOOK_DEGRADED" | "IDENTITY_UNKNOWN" | "CONFIRM_REQUIRED";

export interface TerminalPublicState {
  leaseId: string | null;
  mode: TerminalMode | null;
  phase: TerminalPhase;
  folder: string | null;
  initialSessionId: string | null;
  currentSessionId: string | null;
  backend: TerminalBackend | null;
  message?: string;
  canManualRelease: boolean;
}
```

```ts
// ClientMessage 新增
| { type: "terminal.open"; mode: TerminalMode }
| { type: "terminal.close"; leaseId: string }
| { type: "terminal.release"; leaseId: string; confirmedClosed: true }

// ServerMessage 新增
| { type: "terminal.state"; state: TerminalPublicState }
| { type: "terminal.opened"; leaseId: string; mode: TerminalMode; backend: TerminalBackend }
| { type: "terminal.error"; code: TerminalErrorCode; message: string; leaseId?: string }
| {
    type: "session.mirror.data";
    sessionId: string;
    revision: number;
    messages: HistoryMessage[];
    hasMore: boolean;
    nextCursor?: string;
  }
```

在 `parseClientMessage` 的 `switch` 中加入：

```ts
case "terminal.open":
  return m.mode === "system" || m.mode === "embedded"
    ? { type: "terminal.open", mode: m.mode }
    : null;
case "terminal.close":
  return typeof m.leaseId === "string" && /^[a-f0-9-]{36}$/.test(m.leaseId)
    ? { type: "terminal.close", leaseId: m.leaseId }
    : null;
case "terminal.release":
  return typeof m.leaseId === "string" && /^[a-f0-9-]{36}$/.test(m.leaseId)
    && m.confirmedClosed === true
    ? { type: "terminal.release", leaseId: m.leaseId, confirmedClosed: true }
    : null;
```

leaseId 使用统一常量 `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`，两个解析分支都调用 `UUID_RE.test(m.leaseId)`；Hook 的 sessionId 和 `--session-id` 也复用该校验，拒绝非规范 UUID，不能把任意字符串用于文件路径。

- [ ] **Step 4: 同步并运行 GREEN**

Run: `node scripts/sync-protocol.mjs && npm --prefix bridge test -- tests/protocol.test.ts && npm --prefix bridge run typecheck`
Expected: 终端协议测试 PASS，既有协议测试 PASS，TypeScript exit 0。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add shared/protocol.ts bridge/src/protocol.ts extension/src/lib/protocol.ts bridge/tests/protocol.test.ts docs/superpowers/plans/2026-11-10-terminal-core-system.md
git commit -m "新增终端接管与镜像协议"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

Expected: 仅用户本人作者/提交者，提交正文无 `Co-Authored-By`。未获授权时跳过本步。

---

### Task 2: Lease 状态机与私有持久化

**Files:**
- Create: `bridge/src/terminal-lease.ts`
- Create: `bridge/src/terminal-store.ts`
- Test: `bridge/tests/terminal-lease.test.ts`
- Test: `bridge/tests/terminal-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TerminalPublicState`、`TerminalMode`、`TerminalBackend`。
- Produces: `TerminalLeaseManager.open()`、`confirmSession()`、`degrade()`、`requestStop()`、`completeExit()`、`forceRelease()`。
- Produces: `TerminalRuntimeHandle`、`TerminalStartContext`、`TerminalLeaseRecord`，系统与内嵌适配器共用。

- [ ] **Step 1: 写状态迁移和脱敏失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { TerminalLeaseManager, type TerminalRuntimeHandle } from "../src/terminal-lease";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";

function runtime(exit: (fn: (code: number | null) => void) => void): TerminalRuntimeHandle {
  return { pid: 1234, backend: "windows-terminal", onExit: exit, stop: vi.fn(async () => {}) };
}

describe("TerminalLeaseManager", () => {
  it("按 starting→active→stopping→idle 迁移，公开状态不含 token", async () => {
    let exited: (code: number | null) => void = () => {};
    const states: string[] = [];
    const restored: string[] = [];
    const manager = new TerminalLeaseManager({
      onState: (s) => { states.push(s.phase); expect(JSON.stringify(s)).not.toContain("hookToken"); },
      onSession: () => {}, onMirror: () => {}, onRestore: (sid) => restored.push(sid), onError: () => {},
    });
    const opened = await manager.open({
      folder: "D:/notes", initialSessionId: SID_1, cliPath: "C:/claude.exe", port: 19280,
      privateDir: "D:/private", mode: "system",
    }, () => Promise.resolve(runtime((fn) => { exited = fn; })));
    expect(opened.phase).toBe("starting");
    expect(manager.confirmSession(opened.leaseId!, {
      event: "SessionStart", sessionId: SID_2, cwd: "D:/notes", source: "resume",
      transcriptPath: "D:/home/projects/D--notes/" + SID_2 + ".jsonl",
    })).toBe(true);
    expect(manager.publicState().currentSessionId).toBe(SID_2);
    await manager.requestStop(opened.leaseId!);
    exited(0);
    expect(manager.publicState().phase).toBe("idle");
    expect(restored).toEqual([SID_2]);
    expect(states).toEqual(["starting", "active", "stopping", "idle"]);
  });

  it("SessionEnd 不释放 lease，启动失败恢复初始会话", async () => {
    const restored: Array<string | null> = [];
    const manager = new TerminalLeaseManager({
      onState: () => {}, onSession: () => {}, onMirror: () => {}, onRestore: (sid) => restored.push(sid), onError: () => {},
    });
    await expect(manager.open({
      folder: "D:/notes", initialSessionId: SID_1, cliPath: "missing", port: 1,
      privateDir: "D:/private", mode: "system",
    }, () => Promise.reject(new Error("spawn failed")))).rejects.toThrow("spawn failed");
    expect(manager.publicState().phase).toBe("idle");
    expect(restored).toEqual([SID_1]);
  });
});
```

`onRestore` 的准确类型为 `(sessionId: string | null) => void | Promise<void>`；`completeExit` 必须等待最终镜像回调后再调用它。

- [ ] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/terminal-lease.test.ts`
Expected: FAIL，`../src/terminal-lease` 不存在。

- [ ] **Step 3: 实现 lease 接口和状态机**

新文件导出以下完整公共接口；实现中所有异步退出都先执行 `onMirror(record.currentSessionId)`，再执行 `onRestore`，最后广播 idle：

```ts
import { randomBytes, randomUUID } from "node:crypto";
import type { TerminalBackend, TerminalMode, TerminalPublicState } from "./protocol";

export interface ProcessIdentity {
  pid: number;
  executable: string;
  startedAt: string;
}

export interface TerminalStartContext {
  leaseId: string;
  hookToken: string;
  mode: TerminalMode;
  folder: string;
  initialSessionId: string | null;
  resumeSessionId: string;
  cliPath: string;
  port: number;
  privateDir: string;
}

export interface TerminalRuntimeHandle {
  pid: number | null;
  backend: TerminalBackend;
  identity?: ProcessIdentity;
  onExit(callback: (exitCode: number | null, reason?: string) => void): void;
  stop(): Promise<void>;
}

export type TerminalRuntimeFactory = (context: TerminalStartContext) => Promise<TerminalRuntimeHandle>;

export interface TerminalLeaseRecord extends TerminalStartContext {
  phase: Exclude<TerminalPublicState["phase"], "idle">;
  currentSessionId: string | null;
  confirmedSessionId: string | null;
  backend: TerminalBackend | null;
  pid: number | null;
  identity?: ProcessIdentity;
  createdAt: string;
  message?: string;
  canManualRelease: boolean;
}

export interface TerminalLeaseEvents {
  onState(state: TerminalPublicState): void;
  onSession(sessionId: string, previousSessionId: string | null): void;
  onMirror(sessionId: string | null): void | Promise<void>;
  onRestore(sessionId: string | null): void | Promise<void>;
  onError(code: "HOOK_DEGRADED" | "START_FAILED" | "IDENTITY_UNKNOWN", message: string): void;
}

export interface TerminalOpenInput {
  folder: string;
  initialSessionId: string | null;
  cliPath: string;
  port: number;
  privateDir: string;
  mode: TerminalMode;
}
```

`open()` 的完整实现契约如下（代码可直接作为方法体）：

```ts
async open(
  input: TerminalOpenInput,
  start: (context: TerminalStartContext) => Promise<TerminalRuntimeHandle>,
): Promise<TerminalPublicState> {
  if (this.record) throw new Error("ALREADY_ACTIVE");
  const context: TerminalStartContext = {
    ...input,
    leaseId: randomUUID(),
    hookToken: randomBytes(32).toString("base64url"),
    resumeSessionId: input.initialSessionId ?? randomUUID(),
  };
  this.record = {
    ...context, phase: "starting", currentSessionId: input.initialSessionId,
    confirmedSessionId: null, backend: null, pid: null,
    createdAt: new Date().toISOString(), canManualRelease: false,
  };
  this.emit();
  try {
    const handle = await start(context);
    if (this.record?.leaseId !== context.leaseId) {
      await handle.stop();
      throw new Error("START_SUPERSEDED");
    }
    this.record.pid = handle.pid;
    this.record.identity = handle.identity;
    this.record.backend = handle.backend;
    this.handle = handle;
    handle.onExit((code, reason) => { void this.completeExit(context.leaseId, code, reason); });
    return this.publicState(); // 不重复广播 starting；后端由 terminal.opened 定向返回
  } catch (error) {
    this.record = null;
    this.handle = null;
    await this.events.onRestore(input.initialSessionId);
    this.emit();
    throw error;
  }
}
```

同时实现：

```ts
confirmSession(leaseId: string, event: {
  event: "SessionStart" | "SessionEnd";
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  source?: "startup" | "resume" | "clear" | "compact" | "fork";
}): boolean {
  const record = this.record;
  if (!record || record.leaseId !== leaseId || record.phase === "stopping") return false;
  if (event.event === "SessionEnd") return true; // 只有进程退出能释放 lease
  const previous = record.currentSessionId;
  record.currentSessionId = event.sessionId;
  record.confirmedSessionId = event.sessionId;
  record.phase = "active";
  delete record.message;
  this.emit();
  if (previous !== event.sessionId) this.events.onSession(event.sessionId, previous);
  return true;
}

async requestStop(leaseId: string): Promise<void> {
  if (!this.record || this.record.leaseId !== leaseId) throw new Error("NOT_FOUND");
  if (this.record.phase === "stopping") return;
  this.record.phase = "stopping";
  this.emit();
  await this.handle?.stop();
}

async forceRelease(leaseId: string): Promise<void> {
  if (!this.record || this.record.leaseId !== leaseId || !this.record.canManualRelease) {
    throw new Error("CONFIRM_REQUIRED");
  }
  const restore = this.record.confirmedSessionId ?? this.record.initialSessionId;
  this.record = null;
  this.handle = null;
  await this.events.onRestore(restore);
  this.emit();
}
```

新增 `degrade(leaseId, message)` 只改 phase/message 并保持只读；`completeExit` 用 `confirmedSessionId ?? initialSessionId` 恢复，私有 `emit()` 返回仅含 `TerminalPublicState` 字段的新对象。`idle` 的字段全部为 null/false。

- [ ] **Step 4: 添加原子存储并运行 GREEN**

`terminal-store.ts` 提供：

```ts
export class TerminalLeaseStore {
  constructor(private readonly file: string) {}
  load(): TerminalLeaseRecord | null;
  save(record: TerminalLeaseRecord): void;
  clear(leaseId: string): void;
}
```

使用 `fs.readFileSync(file, "utf8")`、严格字段校验、`writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 })` 和 `renameSync(temp, file)`。`clear` 只有文件内 leaseId 相同才删除。存储测试断言保存/加载一致、坏 JSON 返回 null、旧 lease 清理不会删新记录，并断言公开状态不含 `hookToken`（私有记录必须含它供重启验证）。

Run: `npm --prefix bridge test -- tests/terminal-lease.test.ts tests/terminal-store.test.ts && npm --prefix bridge run typecheck`
Expected: 状态迁移、启动失败恢复、存储校验全部 PASS，类型检查 exit 0。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/terminal-lease.ts bridge/src/terminal-store.ts bridge/tests/terminal-lease.test.ts bridge/tests/terminal-store.test.ts
git commit -m "实现终端会话接管状态机"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 3: HTTP Hooks、路径归属与 10 秒降级

**Files:**
- Create: `bridge/src/terminal-hooks.ts`
- Create: `bridge/src/terminal-hook-helper.ts`
- Create: `bridge/src/cli-capabilities.ts`
- Create: `bridge/scripts/probe-cli-hooks.mjs`
- Modify: `bridge/src/server.ts:1235-1243`
- Modify: `bridge/src/index.ts`, `bridge/src/tray.ts`
- Test: `bridge/tests/terminal-hooks.test.ts`
- Test: `bridge/tests/terminal-hook-helper.test.ts`
- Test: `bridge/tests/terminal-lease.test.ts`

**Interfaces:**
- Consumes: `TerminalLeaseRecord`、`TerminalLeaseManager.confirmSession/degrade`。
- Produces: `writeTerminalSettings(context, transport)`、`readHookJson(req)`、`parseHookEvent()`、`validateHookEvent()`。
- `TerminalHookTransport = "http" | "command"`；真实探针证明本机 CLI 2.1.316 的 HTTP Hook 10 秒未到达，而 command 对照成功，因此生产当前一律走 command helper。HTTP settings/接收端保留，但只有后续真实探针成功才能启用，不能按 semver 或文档猜测；两条路线进入同一校验/lease 逻辑。
- HTTP 路径固定 `/terminal-hook/<leaseId>`；body 上限独立为 65,536 bytes，不改变 `/config` 的 4 KiB 限制。

- [ ] **Step 1: 写 Hook 安全和降级测试**

```ts
const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const validPayload = {
  hook_event_name: "SessionStart", session_id: SID_2, cwd: "D:/notes",
  transcript_path: "D:/home/projects/D--notes/" + SID_2 + ".jsonl", source: "resume",
} as const;

function makeRecord(): TerminalLeaseRecord {
  return {
    leaseId: LEASE_ID, hookToken: "test-hook-token", mode: "system", folder: "D:/notes",
    initialSessionId: SID_1, resumeSessionId: SID_1, currentSessionId: SID_1,
    confirmedSessionId: null, cliPath: "C:/claude.exe", port: 19280,
    privateDir: "D:/private", phase: "starting", backend: null, pid: 1234,
    createdAt: "2026-11-10T00:00:00.000Z", canManualRelease: false,
  };
}

async function makeStartedManager(): Promise<TerminalLeaseManager> {
  const manager = new TerminalLeaseManager({
    onState: () => {}, onSession: () => {}, onMirror: () => {}, onRestore: () => {}, onError: () => {},
  });
  await manager.open({
    folder: "D:/notes", initialSessionId: SID_1, cliPath: "C:/claude.exe", port: 19280,
    privateDir: "D:/private", mode: "system",
  }, () => Promise.resolve(runtime(() => {})));
  return manager;
}

async function makeActiveManager(): Promise<TerminalLeaseManager> {
  const manager = await makeStartedManager();
  const leaseId = manager.publicState().leaseId!;
  manager.confirmSession(leaseId, {
    event: "SessionStart", sessionId: SID_1, cwd: "D:/notes", source: "resume",
    transcriptPath: "D:/home/projects/D--notes/" + SID_1 + ".jsonl",
  });
  return manager;
}

function endEvent(reason: "clear" | "resume") {
  return {
    event: "SessionEnd" as const, sessionId: SID_1, cwd: "D:/notes", reason,
    transcriptPath: "D:/home/projects/D--notes/" + SID_1 + ".jsonl",
  };
}

it.each(["startup", "resume", "clear", "compact", "fork"] as const)("接受 %s 的合法 SessionStart", (source) => {
  const event = parseHookEvent(JSON.stringify({
    hook_event_name: "SessionStart", session_id: SID_2, cwd: "D:/notes",
    transcript_path: "D:/home/projects/D--notes/" + SID_2 + ".jsonl", source,
  }));
  expect(event).toMatchObject({ event: "SessionStart", sessionId: SID_2, source });
});

it("拒绝伪造 cwd、transcript、sessionId 和错误 token", () => {
  const record = makeRecord(); // 测试工厂返回 Task 2 的合法 TerminalLeaseRecord
  const event = parseHookEvent(validPayload)!;
  expect(validateHookEvent(record, record.hookToken, event, "D:/home/projects")).toBeNull();
  expect(validateHookEvent(record, "wrong", event, "D:/home/projects")).toBe("TOKEN");
  expect(validateHookEvent(record, record.hookToken, { ...event, cwd: "D:/other" }, "D:/home/projects")).toBe("CWD");
  expect(validateHookEvent(record, record.hookToken, { ...event, transcriptPath: "D:/other.jsonl" }, "D:/home/projects")).toBe("TRANSCRIPT");
  expect(parseHookEvent(JSON.stringify({ ...validPayload, session_id: "../escape" }))).toBeNull();
});

it("10 秒无有效 SessionStart 进入 degraded，但不恢复写入", async () => {
  vi.useFakeTimers();
  const manager = await makeStartedManager(); // 注入 Task 2 fake runtime，进程保持存活
  await vi.advanceTimersByTimeAsync(10_000);
  expect(manager.publicState()).toMatchObject({ phase: "degraded", canManualRelease: false });
  expect(manager.publicState().currentSessionId).toBe(SID_1);
  vi.useRealTimers();
});

it("SessionEnd(clear) 后新 SessionStart 到达前仍为 active/stopping，不释放", async () => {
  const manager = await makeActiveManager();
  expect(manager.confirmSession(manager.publicState().leaseId!, endEvent("clear"))).toBe(true);
  expect(manager.publicState().phase).toBe("active");
});
it("command helper 从 stdin 转发同一事件，token 只从私有环境读取", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
  await runTerminalHookHelper({
    stdin: Readable.from([JSON.stringify(validPayload)]),
    env: { CCC_TERMINAL_HOOK_URL: `http://127.0.0.1:19280/terminal-hook/${LEASE_ID}`, CCC_TERMINAL_HOOK_TOKEN: "secret" },
    fetchImpl: fetchMock,
  });
  const [, init] = fetchMock.mock.calls[0]!;
  expect(init?.method).toBe("POST");
  expect(init?.body).toBe(JSON.stringify(validPayload));
  expect(JSON.stringify(init)).toContain("Bearer secret"); // 仅 fake 断言，测试输出不得打印该对象
  expect(JSON.stringify(validPayload)).not.toContain("secret");
});

it("未经真实探针验证的版本一律选择 command", () => {
  expect(selectHookTransport("2.1.315")).toBe("command");
  expect(selectHookTransport("2.1.316")).toBe("command");
  expect(selectHookTransport("99.0.0")).toBe("command");
  expect(selectHookTransport("unknown")).toBe("command");
});
```

以上工厂使用 Task 2 已定义的 `runtime()`、`SID_1`、`SID_2` 和完整事件类型；把它们放在 `terminal-hooks.test.ts` 顶部并显式导入 `TerminalLeaseRecord`、`TerminalLeaseManager`，不使用 `any`。`confirmSession` 的事件类型还需包含可选 `reason?: "clear" | "resume" | "logout" | "prompt_input_exit" | "other"`，与 `endEvent` 和 CLI SessionEnd 输入一致。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/terminal-hooks.test.ts tests/terminal-hook-helper.test.ts tests/terminal-lease.test.ts`
Expected: FAIL，`terminal-hooks`/`terminal-hook-helper` 不存在且 `degrade` 定时器尚未实现。

- [ ] **Step 3: 实现 settings 与严格 Hook 解析**

`terminal-hooks.ts` 写入的配置必须采用以下结构，token 只在私有文件和请求头中：

```ts
export type TerminalHookTransport = "http" | "command";

export function terminalSettings(
  context: TerminalStartContext,
  transport: TerminalHookTransport,
  helperCommand?: string,
): Record<string, unknown> {
  const url = `http://127.0.0.1:${context.port}/terminal-hook/${context.leaseId}`;
  const hook = transport === "http"
    ? { type: "http", url, headers: { Authorization: `Bearer ${context.hookToken}` }, timeout: 5 }
    : { type: "command", command: helperCommand!, timeout: 5 };
  if (transport === "command" && !helperCommand) throw new Error("HOOK_HELPER_REQUIRED");
  return {
    hooks: {
      SessionStart: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  };
}

export function writeTerminalSettings(
  context: TerminalStartContext,
  transport: TerminalHookTransport = "http",
  helperCommand?: string,
): string {
  const file = path.join(context.privateDir, `${context.leaseId}.settings.json`);
  fs.mkdirSync(context.privateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(terminalSettings(context, transport, helperCommand), null, 2), { encoding: "utf8", mode: 0o600 });
  if (transport === "command") {
    fs.writeFileSync(path.join(context.privateDir, `${context.leaseId}.hook-token`), context.hookToken, { encoding: "utf8", mode: 0o600 });
  }
  return file;
}
```

`cli-capabilities.ts` 提供 `selectHookTransport` 和以下版本探测；`terminal-hook-helper.ts` 只负责 stdin 转发：

```ts
const execFileAsync = promisify(execFile);
export async function probeCliVersion(cliPath: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, ["--version"], {
      timeout: 3000, maxBuffer: 4096, windowsHide: true, env: process.env,
    });
    return /(\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}
```

`terminal-hook-helper.ts` 提供以下窄接口；stdin 超过 65,536 bytes、URL 非 `127.0.0.1` 或 token 缺失都非零退出，错误不打印 stdin/env：

```ts
export interface HookHelperDeps {
  stdin: NodeJS.ReadableStream;
  env: {
    CCC_TERMINAL_HOOK_URL?: string | undefined;
    CCC_TERMINAL_HOOK_TOKEN?: string | undefined;
  };
  fetchImpl?: typeof fetch;
}
export async function runTerminalHookHelper(deps: HookHelperDeps): Promise<void> {
  const body = await readBounded(deps.stdin, 65_536);
  const url = new URL(deps.env.CCC_TERMINAL_HOOK_URL ?? "");
  const token = deps.env.CCC_TERMINAL_HOOK_TOKEN;
  if (url.hostname !== "127.0.0.1" || !token) throw new Error("HOOK_HELPER_CONFIG");
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(`HOOK_HTTP_${response.status}`);
}

// cli-capabilities.ts
export function selectHookTransport(_version: string): TerminalHookTransport {
  // 2.1.316 的 HTTP 实探超时、command 对照成功；版本号本身不是能力证据。
  return "command";
}
```

`readBounded` 的完整实现：

```ts
async function readBounded(stdin: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    size += chunk.length;
    if (size > maxBytes) throw new Error("HOOK_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

`index.ts`/`tray.ts` 只在显式 `--terminal-hook` 分支调用 helper。`probe-cli-hooks.mjs` 在隔离 `CLAUDE_CONFIG_DIR` 中运行真实 `claude -p probe --settings <file>`，将 `ANTHROPIC_BASE_URL` 指向本机立即返回 400 的假上游、`ANTHROPIC_API_KEY=probe` 仅放在子进程环境；10 秒内收到 SessionStart 即判定 Hook 能力，CLI 随后的假上游错误不算探针失败。探针不得读取用户配置或访问真实中转。

解析返回 Task 2 的事件类型；只接受 UUID、五种 SessionStart source 和 `clear/resume/logout/prompt_input_exit/other` SessionEnd reason。`validateHookEvent` 用 `timingSafeEqual` 比较 token，并用 `path.resolve` 比较：

```ts
const expected = path.join(
  projectsRoot, slugifyPath(path.resolve(record.folder)), `${event.sessionId}.jsonl`,
);
if (path.resolve(event.transcriptPath) !== path.resolve(expected)) return "TRANSCRIPT";
```

`validateHookEvent(record, token, event, projectsRoot)` 的第四参数直接复用 `transcriptProjectsRoot()` 的返回值；该函数只是导出 `transcript.ts:12` 现有 `projectsDir()`，统一 `CCC_FAKE_HOME`/`CLAUDE_CONFIG_DIR`/默认 home 规则，避免测试和生产的根目录算法分叉。Windows 比较统一 `normalizeFolder`，Unix 保留大小写。另导出 `safeTokenEqual(actual: string, expected: string): boolean`，等长时用 `timingSafeEqual`，不等长直接 false，供 Hook 和阶段 B attachToken 共用。

HTTP 读取函数独立设置 64 KiB，超限返回 413；非 POST 返回 405；token/path/session 非法返回 401 或 422，响应体只含固定错误码。`handleConfigRequest` 保持原样。

在 lease 的启动成功处创建可注入 `setTimeout(..., 10_000)`；有效 SessionStart 清除定时器。超时调用：

```ts
degrade(leaseId: string): void {
  if (!this.record || this.record.leaseId !== leaseId || this.record.phase !== "starting") return;
  this.record.phase = "degraded";
  this.record.message = "未收到会话事件；终端内切换会话时插件不能可靠跟随";
  this.events.onError("HOOK_DEGRADED", this.record.message);
  this.emit();
}
```

- [ ] **Step 4: 接入 HTTP 路由并运行 GREEN**

`httpHandler` 先匹配 `/terminal-hook/`，再进入现有 `/config`：

```ts
const httpHandler: http.RequestListener = (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname.startsWith("/terminal-hook/")) {
    void terminalService.handleHookHttp(req, res);
    return;
  }
  void handleConfigRequest(req, res, {
    config, configDir: deps.configDir, getPort: () => current.port, rebind,
  });
};
```

Run: `npm --prefix bridge test -- tests/terminal-hooks.test.ts tests/terminal-hook-helper.test.ts tests/terminal-lease.test.ts && npm --prefix bridge run typecheck && node bridge/scripts/probe-cli-hooks.mjs --transport http`
Expected: 五种 source、无效 token/path、64 KiB 限制、SessionEnd 竞态、10 秒 degraded 和 helper 转发全部 PASS；真实 CLI 探针收到本机 SessionStart，`realApiCalled=false`。若当前 CLI HTTP 探针失败，先记录根因并运行 `--transport command` 验证 helper，不能改猜 mtime。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/terminal-hooks.ts bridge/src/terminal-hook-helper.ts bridge/src/cli-capabilities.ts bridge/src/terminal-lease.ts bridge/src/transcript.ts bridge/src/server.ts bridge/src/index.ts bridge/src/tray.ts bridge/scripts/probe-cli-hooks.mjs bridge/tests/terminal-hooks.test.ts bridge/tests/terminal-hook-helper.test.ts bridge/tests/terminal-lease.test.ts
git commit -m "接入终端会话事件与降级保护"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 4: 常驻 TranscriptWatcher 与 revision 镜像

**Files:**
- Create: `bridge/src/transcript-watcher.ts`
- Create: `bridge/src/terminal-service.ts`
- Create: `extension/src/lib/terminal-mirror.ts`
- Test: `bridge/tests/transcript-watcher.test.ts`
- Test: `bridge/tests/terminal-service.test.ts`
- Test: `extension/tests/terminal-mirror.test.ts`

**Interfaces:**
- Produces: `TranscriptWatcher.bind(folder)`、`close()`，构造参数 `{ debounceMs: 250, reconcileMs: 2000 }`。
- Produces: `TerminalService.pushMirror(sessionId)`，读取 `readHistoryPage(folder, sessionId)` 后广播 `session.mirror.data`。
- Produces: `reduceTerminalMirror(view, message, expectedSessionId)`，忽略旧 sessionId/旧 revision，upsert 最新页并保留旧分页。

- [ ] **Step 1: 写 watcher 与 revision 失败测试**

watcher 测试使用真实临时目录和 fake timers：

```ts
it("防抖合并写入，周期对账发现丢失的单次事件", async () => {
  vi.useFakeTimers();
  const changed: string[] = [];
  const listed: string[] = [];
  const watcher = new TranscriptWatcher({
    debounceMs: 250, reconcileMs: 2000,
    onList: () => listed.push("list"),
    onTranscript: (sessionId) => changed.push(sessionId),
  });
  watcher.bind(work);
  await vi.advanceTimersByTimeAsync(10);
  fs.writeFileSync(transcriptFile(SID_1), "{}\n", "utf8");
  fs.appendFileSync(transcriptFile(SID_1), "{}\n", "utf8");
  await vi.advanceTimersByTimeAsync(250);
  expect(listed).toHaveLength(1);
  expect(changed).toEqual([SID_1]);
  fs.writeFileSync(transcriptFile(SID_2), "{}\n", "utf8"); // 模拟 watch 丢失的新文件事件
  watcher.reconcile(); // 与 2 秒周期计时器调用同一幂等对账函数
  expect(listed).toHaveLength(2);
  expect(changed).toEqual([SID_1, SID_2]);
  watcher.close();
  vi.useRealTimers();
});
```

`reconcile()` 是公开的幂等方法，测试直接调用它模拟 watch 丢事件；另写独立用例在第三次文件变化后只推进 2000 ms 计时器、不手工 reconcile，断言周期对账也能发现变化。不要新增只供生产调用的测试后门。

扩展纯函数测试先定义 `mirror(sessionId, revision)` 工厂，返回 `session.mirror.data`，其中 `messages` 为 `[{ id: "new-item", createdAt: 3, role: "user", text: "新会话" }]`、`hasMore:false`；第二个用例自行构造 `view: TerminalMirrorView`，不能引用上一个 `it` 的局部变量：

```ts
it("旧 revision 不覆盖新页面，最新页更新工具结果且保留已加载旧页", () => {
  const older = [{ id: "history-old", createdAt: 1, role: "user" as const, text: "旧页" }];
  const running = [{ id: "history-tool", createdAt: 2, role: "tool" as const, text: "Read", toolStatus: "running" as const }];
  const view = { sessionId: SID_1, revision: 4, messages: [...older, ...running], hasLoadedOlder: true };
  const next = reduceTerminalMirror(view, {
    type: "session.mirror.data", sessionId: SID_1, revision: 5,
    messages: [{ ...running[0]!, toolStatus: "success", toolOutput: "完整输出" }], hasMore: true,
  }, SID_1);
  expect(next.messages.map((m) => m.id)).toEqual(["history-old", "history-tool"]);
  expect(next.messages[1]).toMatchObject({ toolStatus: "success", toolOutput: "完整输出" });
  expect(next.hasLoadedOlder).toBe(true);
  expect(reduceTerminalMirror(next, {
    type: "session.mirror.data", sessionId: SID_1, revision: 4, messages: [], hasMore: false,
  }, SID_1)).toBe(next);
});

it("只有切换 sessionId 才清空旧会话视图", () => {
  const view: TerminalMirrorView = {
    sessionId: SID_1, revision: 9,
    messages: [{ id: "old-item", createdAt: 1, role: "user", text: "旧会话" }],
    hasLoadedOlder: true,
  };
  const next = reduceTerminalMirror(view, mirror(SID_2, 1), SID_2);
  expect(next.messages.map((m) => m.id)).toEqual(["new-item"]);
});
```

- [ ] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/transcript-watcher.test.ts tests/terminal-service.test.ts && npm --prefix extension test -- tests/terminal-mirror.test.ts`
Expected: FAIL，三个新模块不存在。

- [ ] **Step 3: 实现 watcher 与服务端镜像**

`TranscriptWatcher` 的 `reconcile()` 必须比较 `{sessionId: {mtimeMs,size}}` 快照，区分列表变化和当前 transcript 变化；`fs.watch` 事件只调度同一 `reconcile()`，不直接相信 filename。监听目录不存在时只启动 2 秒计时器，目录出现后补挂 watch。`bind()` 替换旧目录前关闭旧 watcher/timer；`close()` 幂等。

`terminal-service.ts` 的镜像方法：

```ts
pushMirror(sessionId: string): void {
  const lease = this.leases.currentRecord(); // 仅服务端内部读取，序列化广播仍走 publicState()
  if (!lease || lease.currentSessionId !== sessionId) return;
  const page = this.readHistoryPage(lease.folder, sessionId);
  const revision = (this.mirrorRevisions.get(sessionId) ?? 0) + 1;
  this.mirrorRevisions.set(sessionId, revision);
  this.broadcast({
    type: "session.mirror.data", sessionId, revision,
    messages: page.messages, hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  });
}
```

watcher 的 `onList` 始终 `pushSessionList()`；`onTranscript` 只有 lease 当前确认会话匹配时调用 `pushMirror`。degraded 从未确认时只镜像初始 sessionId，绝不从列表首项推断当前会话。

- [ ] **Step 4: 实现前端 reducer 并运行 GREEN**

`terminal-mirror.ts` 导出：

```ts
export interface TerminalMirrorView {
  sessionId: string | null;
  revision: number;
  messages: UiMsg[];
  hasLoadedOlder: boolean;
}

export function reduceTerminalMirror(
  view: TerminalMirrorView,
  message: Extract<ServerMessage, { type: "session.mirror.data" }>,
  expectedSessionId: string | null,
): TerminalMirrorView {
  if (expectedSessionId === null || message.sessionId !== expectedSessionId) return view;
  if (view.sessionId === message.sessionId && message.revision <= view.revision) return view;
  if (view.sessionId !== message.sessionId) {
    return {
      sessionId: message.sessionId, revision: message.revision,
      messages: message.messages.map(toUiMessage), hasLoadedOlder: false,
    };
  }
  return {
    ...view,
    revision: message.revision,
    messages: message.messages.map(toUiMessage).reduce(upsertUiMessage, [...view.messages]),
  };
}
```

把现有 `upsertUiMessage`/历史转换移到该模块并从 App 导入，保持“工具执行与交互决定各占一行、最终状态不被 running 回退”的既有规则。`TerminalLeaseManager.currentRecord(): TerminalLeaseRecord | null` 只供服务端内部读取，不得把返回值直接广播。旧 sessionId 即使 revision 更大也会被 `expectedSessionId` 拒绝；只有当前 sessionId 内才比较 revision。

Run: `npm --prefix bridge test -- tests/transcript-watcher.test.ts tests/terminal-service.test.ts && npm --prefix extension test -- tests/terminal-mirror.test.ts && npm --prefix bridge run typecheck && npm --prefix extension run typecheck`
Expected: watcher 新建/修改/删除/防抖/对账、镜像 upsert、旧包拒绝全部 PASS，两端类型检查 exit 0。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/transcript-watcher.ts bridge/src/terminal-service.ts extension/src/lib/terminal-mirror.ts bridge/tests/transcript-watcher.test.ts bridge/tests/terminal-service.test.ts extension/tests/terminal-mirror.test.ts
git commit -m "同步外部会话列表与终端历史镜像"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 5: CLI 解析复用、私有包装进程和系统终端启动器

**Files:**
- Modify: `bridge/src/claude-session.ts:254-380`
- Create: `bridge/src/process-identity.ts`
- Create: `bridge/src/terminal-child.ts`
- Create: `bridge/src/runtime-entry.ts`
- Create: `bridge/src/system-terminal.ts`
- Modify: `bridge/src/index.ts`, `bridge/src/tray.ts`
- Test: `bridge/tests/system-terminal.test.ts`
- Test: `bridge/tests/terminal-child.test.ts`
- Test: `bridge/tests/process-identity.test.ts`
- Test: `bridge/tests/entrypoints.test.ts`

**Interfaces:**
- Consumes: Task 2 `TerminalStartContext`/`TerminalRuntimeHandle`。
- Produces: `resolveClaudeExecutable()` 公开导出、`ensureShellEnvFallback()` 公开导出。
- Produces: `SystemTerminalAdapter.start(context)`，构造续聊参数、私有 settings、launcher 和进程退出监控。
- Produces: `runTerminalChild(requestFile)`，只在显式 `--terminal-child` 入口执行。

- [x] **Step 1: 写参数、路径和生命周期失败测试**

```ts
it("已有会话续聊且不在命令行暴露 token", async () => {
  const spawn = vi.fn(() => fakeLaunchedProcess());
  const adapter = new SystemTerminalAdapter({ platform: "win32", spawn, which: () => "C:/WindowsTerminal/wt.exe" });
  await adapter.start(context({ initialSessionId: SID_1, resumeSessionId: SID_1 }));
  const request = JSON.parse(fs.readFileSync(path.join(privateDir, `${LEASE_ID}.request.json`), "utf8"));
  expect(request.args).toEqual(["--resume", SID_1, "--settings", expect.stringContaining(".settings.json")]);
  expect(JSON.stringify(request)).not.toContain(HOOK_TOKEN);
  expect(spawn.mock.calls[0]?.[0]).toBe("wt.exe");
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: false, detached: true });
});

it("无会话使用桥接生成的 UUID，wt 缺失明确回退可见控制台", async () => {
  const adapter = new SystemTerminalAdapter({ platform: "win32", spawn, which: () => null });
  const handle = await adapter.start(context({ initialSessionId: null, resumeSessionId: SID_2 }));
  expect(handle.backend).toBe("windows-console");
  expect(readRequest().args).toEqual(["--session-id", SID_2, "--settings", expect.any(String)]);
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: false });
});

it("macOS 用 osascript 启动 Terminal.app，shellQuote 保护空格和单引号", async () => {
  const adapter = new SystemTerminalAdapter({ platform: "darwin", spawn, which: () => null });
  await adapter.start(context({ folder: "/tmp/中文 and 'quote'" }));
  expect(spawn.mock.calls[0]?.[0]).toBe("osascript");
  expect(spawn.mock.calls[0]?.[1]?.join(" ")).toContain('tell application "Terminal"');
  expect(spawn.mock.calls[0]?.[1]?.join(" ")).toContain("'\"'\"'");
});

it("包装进程继承环境但不把环境写盘，退出写 exit.json", async () => {
  await runTerminalChild(requestFile, { spawn: fakeCliSpawn });
  const requestRaw = fs.readFileSync(requestFile, "utf8");
  expect(requestRaw).not.toContain("ANTHROPIC");
  expect(fakeCliSpawn).toHaveBeenCalledWith(cliPath, requestArgs, expect.objectContaining({
    cwd: work, stdio: "inherit", env: process.env, windowsHide: false,
  }));
  expect(readExit()).toEqual({ leaseId: LEASE_ID, exitCode: 0, reason: "exit" });
});
```

测试必须注入 `platform/spawn/which/now/privateDir`，不在 CI 真正打开窗口。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/system-terminal.test.ts tests/terminal-child.test.ts tests/process-identity.test.ts`
Expected: FAIL，三个新模块不存在，`resolveClaudeExecutable` 尚未导出。

- [x] **Step 3: 实现私有启动文件与启动参数**

`probeCliVersion()` 只执行 `claude --version`（3 秒上限），提取首个 semver，失败返回 `unknown`，不启动聊天、不调用 API；单元测试注入 execFile 实现做版本测试。

请求文件只包含非敏感字段：

```ts
export interface TerminalChildRequest {
  leaseId: string;
  cwd: string;
  cliPath: string;
  args: string[];
  exitFile: string;
  stopFile: string;
  hookUrl?: string;
  hookTokenFile?: string;
}
```

`SystemTerminalAdapter.start()` 按以下规则创建文件：

```ts
const transport = selectHookTransport(await probeCliVersion(context.cliPath));
const helperCommand = transport === "command" ? terminalHookCommand(context.leaseId) : undefined;
const args = [
  ...(context.initialSessionId
    ? ["--resume", context.initialSessionId]
    : ["--session-id", context.resumeSessionId]),
  "--settings", writeTerminalSettings(context, transport, helperCommand),
];
const request: TerminalChildRequest = {
  leaseId: context.leaseId, cwd: context.folder, cliPath: context.cliPath, args,
  exitFile: path.join(context.privateDir, `${context.leaseId}.exit.json`),
  stopFile: path.join(context.privateDir, `${context.leaseId}.stop`),
  ...(transport === "command" ? {
    hookUrl: `http://127.0.0.1:${context.port}/terminal-hook/${context.leaseId}`,
    hookTokenFile: path.join(context.privateDir, `${context.leaseId}.hook-token`),
  } : {}),
};
fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), "utf8");
```

Windows launcher 是私有 `.cmd`，内容如下，不包含 token 或环境：

```ts
const launcher = path.join(context.privateDir, `${context.leaseId}.cmd`);
const command = this.childCommand;
const childArgs = [...command.prefixArgs, "--terminal-child", requestFile]
  .map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" ");
const content = `@echo off\r\n"${command.executable}" ${childArgs}\r\n`;
fs.writeFileSync(launcher, content, "utf8");
```

`SystemTerminalAdapter` 构造参数增加 `childCommand?: TerminalChildCommand`，默认 `terminalChildCommand()`；测试显式注入 `{ executable: "C:/bridge/ccc-bridge.exe", prefixArgs: [] }`，避免测试依赖当前 tsx 进程。

`wt.exe` 参数为 `["-d", context.folder, "cmd.exe", "/d", "/c", launcher]`。回退为 `spawn("cmd.exe", ["/c", "start", "CopilotCC Terminal", "/D", context.folder, launcher], { detached: true, stdio: "ignore", windowsHide: false })`。macOS 用 `osascript -e` 执行 `activate` 和 `do script`，脚本只包含 shellQuote 后的 `cd`、`process.execPath --terminal-child requestFile`；`shellQuote` 完整实现为：

```ts
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
```

启动器只把 GUI 拉起进程当启动结果，包装进程的 PID/启动身份从 `<leaseId>.status.json` 读取并核对；`wt.exe` 返回不代表 Claude 退出。

- [x] **Step 4: 实现包装进程、身份核对并运行 GREEN**

`runTerminalChild` 启动时先写 `{leaseId,pid:process.pid,executable:process.execPath,startedAt:<OS 启动时间>}`，随后：

```ts
const hookToken = request.hookTokenFile
  ? fs.readFileSync(request.hookTokenFile, "utf8")
  : null;
const childEnv = hookToken && request.hookUrl
  ? { ...process.env, CCC_TERMINAL_HOOK_URL: request.hookUrl, CCC_TERMINAL_HOOK_TOKEN: hookToken }
  : process.env;
const child = spawn(request.cliPath, request.args, {
  cwd: request.cwd, stdio: "inherit", env: childEnv, windowsHide: false,
});
const stopTimer = setInterval(() => {
  if (fs.existsSync(request.stopFile)) child.kill();
}, 250);
child.once("error", (error) => {
  clearInterval(stopTimer);
  writeExit({ leaseId: request.leaseId, exitCode: null, reason: `spawn: ${error.message}` });
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  clearInterval(stopTimer);
  writeExit({ leaseId: request.leaseId, exitCode: code, reason: signal ?? "exit" });
});
```

`process-identity.ts` 在 Windows 通过 `powershell -NoProfile -Command` 查询指定 PID 的 `ExecutablePath` 和 `CreationDate`，macOS 通过 `/bin/ps -p <pid> -o comm= -o lstart=`；输出只用于比较，不写日志。PID 缺失、查询失败、路径或启动时间不匹配均返回 `unknown`，不能仅靠 PID 判断存活。

`index.ts`/`tray.ts` 在常规 main 之前检测 `process.argv[2] === "--terminal-child"`，只接受第三个参数为 `CCC_BRIDGE_HOME/terminal` 内的 request 文件，调用 `runTerminalChild` 后直接结束分支。生产入口测试断言两个入口都接入此分发，正常 `start` 和 `--smoke` 行为不变。

Run: `npm --prefix bridge test -- tests/system-terminal.test.ts tests/terminal-child.test.ts tests/process-identity.test.ts tests/entrypoints.test.ts && npm --prefix bridge run typecheck`
Expected: resume/new UUID、中文/空格路径、可见窗口配置、Terminal.app、退出状态和入口装配全部 PASS。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/claude-session.ts bridge/src/process-identity.ts bridge/src/terminal-child.ts bridge/src/runtime-entry.ts bridge/src/system-terminal.ts bridge/src/index.ts bridge/src/tray.ts bridge/tests/system-terminal.test.ts bridge/tests/terminal-child.test.ts bridge/tests/process-identity.test.ts bridge/tests/entrypoints.test.ts
git commit -m "实现系统终端续聊启动与生命周期跟踪"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 6: Server 接线、双写防护和桥接重启恢复

**Files:**
- Modify: `bridge/src/server.ts:23-210,499-610,798-842,1060-1187,1308-1876`
- Modify: `bridge/src/terminal-service.ts`
- Modify: `bridge/src/index.ts`, `bridge/src/tray.ts`
- Test: `bridge/tests/server-terminal.test.ts`
- Modify: `bridge/tests/server-mirror.test.ts`
- Modify: `bridge/tests/entrypoints.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5 全部接口。
- Produces: `ServerDeps.terminal?: { system: TerminalRuntimeFactory; privateDir: string }`，`startServer` 在 workspace/aliases/广播回调可读后创建唯一 `TerminalService`；生产入口始终注入，旧单测缺省时使用 disabled service 并返回明确 `START_FAILED`。
- Produces: `terminal.open/close/release` 处理、只读 guard、快照 `terminal.state`、系统 lease 恢复。

- [x] **Step 1: 写端到端 WS 失败测试**

复用 `server-mirror.test.ts` 的真实 WS 测试方式，新文件覆盖：

```ts
it("接管后所有写请求被服务端拒绝，历史/分页/草稿仍可用", async () => {
  const { server, url, terminal } = await bootTerminal({ initialSessionId: SID_1 });
  const a = await connect(url);
  const inbox = collect(a.ws);
  a.ws.send(JSON.stringify({ type: "folder.bind", path: work }));
  await inbox.waitFor("folder.bound");
  a.ws.send(JSON.stringify({ type: "terminal.open", mode: "system" }));
  const opened = await inbox.waitFor("terminal.opened") as Extract<ServerMessage, { type: "terminal.opened" }>;
  for (const message of [
    { type: "chat.send", text: "不得双写" }, { type: "chat.abort" },
    { type: "session.new" }, { type: "session.switch", sessionId: SID_2 },
    { type: "session.delete", sessionId: SID_2 }, { type: "folder.bind", path: work },
    { type: "alias.select", id: "alias-1" }, { type: "alias.delete", id: "alias-1" },
    { type: "permission.response", requestId: "p1", allow: true },
    { type: "chat.ask.answer", requestId: "a1", answers: {} },
    { type: "settings.set", permissionMode: "plan" },
  ]) a.ws.send(JSON.stringify(message));
  const errors = await waitCount(inbox.inbox, "terminal.error", 11);
  expect(errors.every((m) => m.type === "terminal.error" && m.code === "READ_ONLY")).toBe(true);
  expect(terminal.sdkSend).not.toHaveBeenCalled();
  a.ws.send(JSON.stringify({ type: "session.history", limit: 10 }));
  await inbox.waitFor("session.history.data");
  a.ws.send(JSON.stringify({ type: "chat.draft", text: "保留草稿" }));
  a.ws.send(JSON.stringify({ type: "client.ready" }));
  const sync = await inbox.waitFor("chat.sync") as Extract<ServerMessage, { type: "chat.sync" }>;
  expect(sync.draft).toBe("保留草稿");
  await server.close();
});

it("有效 hook 切换会话并更新别名，普通新文件不能抢占镜像", async () => {
  const fixture = await activeSystemTerminal();
  fs.writeFileSync(transcriptFile(SID_2), userLine("普通终端的新会话"), "utf8");
  await fixture.inbox.waitFor("session.list.data");
  expect(fixture.sessions.get(work)?.sessionId).toBe(SID_1);
  await postHook(fixture, validHook(SID_2, "clear"));
  const bound = await fixture.inbox.waitFor("folder.bound") as Extract<ServerMessage, { type: "folder.bound" }>;
  expect(bound).toMatchObject({ sessionId: SID_2, reset: true });
  expect(fixture.aliases.get("alias-1")?.sessionId).toBe(SID_2);
  await postHook(fixture, { ...validHook(SID_2, "clear"), source: "compact" });
  expect(fixture.manager.publicState().currentSessionId).toBe(SID_2);
});

it("busy/待审批拒绝启动；启动失败恢复原 Query", async () => {
  const busy = await bootBusyWorkspace();
  busy.ws.send(JSON.stringify({ type: "terminal.open", mode: "system" }));
  expect(await busy.inbox.waitFor("terminal.error")).toMatchObject({ code: "WORKSPACE_BUSY" });
  expect(busy.fakeHandle.close).not.toHaveBeenCalled();
  const failed = await bootFailedTerminal();
  failed.ws.send(JSON.stringify({ type: "terminal.open", mode: "system" }));
  await failed.inbox.waitFor("terminal.error");
  expect(failed.createdSessions).toHaveLength(2); // 初始 Query + 失败回滚 Query
  expect(failed.createdSessions[1]?.opts.resumeId).toBe(SID_1);
});

it("进程退出后先最终镜像，再按最后 hook 会话恢复；双视图收到 idle", async () => {
  const fixture = await activeSystemTerminalWithTwoViews();
  await postHook(fixture, validHook(SID_2, "resume"));
  fixture.runtime.exit(0);
  await vi.waitFor(() => expect(fixture.manager.publicState().phase).toBe("idle"));
  expect(fixture.events.slice(-3)).toEqual(["mirror:" + SID_2, "restore:" + SID_2, "state:idle"]);
  expect(fixture.viewA.inbox.at(-1)).toMatchObject({ type: "terminal.state", state: { phase: "idle" } });
  expect(fixture.viewB.inbox.at(-1)).toMatchObject({ type: "terminal.state", state: { phase: "idle" } });
});
```

再增加恢复矩阵：进程身份匹配→恢复只读；exit.json 已存在→最终同步后 idle；身份 unknown→保持只读且 `canManualRelease=true`；未确认 `terminal.release` 不得清 lease；确认后恢复最后 hook 会话且不调用 kill。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/server-terminal.test.ts tests/server-mirror.test.ts tests/entrypoints.test.ts`
Expected: FAIL，`terminal.open` 没有处理分支，`terminal.state` 没有快照，guard 不存在。

- [x] **Step 3: 实现 TerminalService 与 SDK 停机/恢复**

服务构造函数只接受明确的依赖，不从客户端读取路径：

```ts
export interface TerminalServiceDeps {
  sessions: SessionManager;
  aliases?: AliasManager;
  getWorkspace(): {
    folder: string | null;
    currentAliasId: string | null;
    busy: boolean;
    pendingCount: number;
    sessionId: string | null;
  };
  suspendSdk(): Promise<void>;
  restoreSdk(sessionId: string | null): void;
  readHistoryPage(folder: string, sessionId: string): TranscriptPage;
  broadcast(message: ServerMessage): void;
  pushSessionList(): void;
  syncCurrentAlias(): void;
  pushAliasList(): void;
  configDir: string;
  getPort(): number;
  resolveCli(): string | undefined;
  system: TerminalRuntimeFactory;
}
```

`open(mode, ws)` 先执行“当前别名 folder，否则 workspace folder”解析，校验 `isValidFolder`、`busy=false`、`pendingCount=0`。starting 状态必须在 `await suspendSdk()` 之前广播。`pendingCount` 的准确值为 `Number(Boolean(workspace.pendingPerm)) + Number(Boolean(workspace.pendingAsk)) + workspace.pendingInteractions.size`，任一待审批/Ask/MCP/用户对话框都拒绝。watcher 在每次 `bindFolder` 成功后绑定新 projects 目录，在换绑前解绑旧目录，并在 workspaceStore 启动恢复绑定后立即启动；因此普通外部终端在无 lease 时也能被发现。`suspendSdk` 做：

```ts
const old = workspace.claude;
workspace.claude = null;
workspace.sessionEpoch += 1; // 旧 Query 迟到事件全部失效
await old?.close();
```

启动失败、退出和人工解除统一走 `restoreSdk(sessionId)`：更新 sessions 映射、syncCurrentAlias/pushAliasList、`openSession(sessionId ?? undefined)`，广播 `folder.bound`，且只在 sessionId 真变化时 `reset:true`。`initialSessionId=null` 且从未 hook 确认时恢复 null，不采用 watcher 最新文件。

WS 写保护放在消息分发统一入口：

```ts
const TERMINAL_READ_ONLY = new Set<ClientMessage["type"]>([
  "chat.send", "chat.abort", "permission.response", "chat.ask.answer", "chat.interaction.respond",
  "session.new", "session.switch", "session.delete", "folder.bind",
  "alias.create", "alias.select", "alias.update", "alias.delete",
]);

function blockedByTerminal(m: ClientMessage): boolean {
  if (!terminalService.isActive()) return false;
  if (m.type === "settings.set" && m.hello !== true) return true;
  return TERMINAL_READ_ONLY.has(m.type);
}
```

在 `for (const m of messages)` 的 switch 前拒绝并 `send({type:"terminal.error",code:"READ_ONLY",message:"终端接管中，当前为只读镜像",leaseId})`。`client.ready`、history/list、folder.pick/open、chat.draft、terminal.* 保持可用。

- [x] **Step 4: 实现所有权、快照、恢复并运行 GREEN**

每个 WebSocket 在闭包内记录 `ownedTerminalLease: string | null`。`terminal.open` 成功记录 owner；其它连接 close 返回 `NOT_OWNER`。owner WS 断开不结束系统终端，只清除连接指针；进程退出仍是唯一正常释放条件。恢复后的 unknown lease 允许 `terminal.release confirmedClosed:true`，该操作只清 lease，不调用 runtime.stop。

`pushSnapshot` 在绑定/历史后发送 `{ type:"terminal.state", state:terminalService.publicState() }`，再发送 chat.sync。`onState` 对非 idle 的系统 lease 调 `TerminalLeaseStore.save(currentRecord())`，idle 按旧 leaseId 原子 clear；embedded 在阶段 B 使用独立恢复记录，不写入系统 lease 文件。`StartedServer.close` 先关闭 watcher 和计时器，再关闭 SDK；系统包装进程不因普通 WS 断开被杀，桥接正常退出按 spec 只结束自己拥有的内嵌 PTY（阶段 B），系统 lease 留给重启核对。

生产入口只注入适配依赖：

```ts
startServer({
  config, sessions, aliases, workspaceStore,
  terminal: {
    privateDir: path.join(configDir(), "terminal"),
    system: (context) => new SystemTerminalAdapter({ childCommand: terminalChildCommand() }).start(context),
  },
});
```

`startServer` 内部用同一 workspace、sessions、aliases 和广播函数构造 `TerminalServiceDeps`，不创建第二份 workspace。新增 `bridge/src/runtime-entry.ts`：

```ts
export interface TerminalChildCommand { executable: string; prefixArgs: string[] }
export function terminalChildCommand(): TerminalChildCommand {
  const entry = process.argv[1] ?? "";
  if (entry.endsWith(".ts")) {
    return {
      executable: process.execPath,
      prefixArgs: [path.resolve("node_modules", "tsx", "dist", "cli.mjs"), path.resolve(entry)],
    };
  }
  return { executable: process.execPath, prefixArgs: [] };
}

export function terminalHookCommand(leaseId: string): string {
  const command = terminalChildCommand();
  const parts = [command.executable, ...command.prefixArgs, "--terminal-hook", leaseId];
  return parts.map((part) => process.platform === "win32"
    ? `"${part.replace(/"/g, "")}"`
    : `'${part.replace(/'/g, `'"'"'`)}'`).join(" ");
}
```

`SystemTerminalAdapter` 的私有 launcher 调用 `childCommand.executable ...childCommand.prefixArgs --terminal-child requestFile`，因此开发态经 tsx 入口、编译态经桥接 exe，不假设 `process.execPath` 永远是桥接程序。入口测试断言 `terminal.system` 和私有目录已注入，并分别模拟 `.ts` 与编译入口参数。

Run: `npm --prefix bridge test -- tests/server-terminal.test.ts tests/server-mirror.test.ts tests/entrypoints.test.ts && npm --prefix bridge test && npm --prefix bridge run typecheck`
Expected: 新增测试及桥接完整测试全部 PASS，0 failures，类型检查 exit 0。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/server.ts bridge/src/terminal-service.ts bridge/src/index.ts bridge/src/tray.ts bridge/tests/server-terminal.test.ts bridge/tests/server-mirror.test.ts bridge/tests/entrypoints.test.ts
git commit -m "接管系统终端并防止插件双写"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 7: 扩展系统终端入口、只读界面和双视图镜像

**Files:**
- Modify: `extension/src/entrypoints/sidepanel/App.tsx`
- Modify: `extension/src/components/AliasBar.tsx`
- Modify: `extension/src/components/FolderBar.tsx`
- Modify: `extension/src/components/InputBox.tsx`
- Modify: `extension/src/components/PermissionCard.tsx`, `AskCard.tsx`, `ElicitationCard.tsx`, `UserDialogCard.tsx`
- Modify: `extension/src/entrypoints/sidepanel/style.css`
- Modify: `extension/tests/app-tool-flow.test.tsx`
- Modify: `extension/tests/input-box.test.tsx`

**Interfaces:**
- Consumes: `terminal.state/opened/error`、`session.mirror.data` 和 Task 4 reducer。
- Stage A 主行只显示 `>_` 系统终端按钮；Stage B 将同一按钮扩成两个命令的菜单，避免中间版本出现无后端的“插件终端”入口。

- [x] **Step 1: 写真实 App 失败测试**

在 `app-tool-flow.test.tsx` 使用现有 FakeWebSocket：

```ts
it("别名主行发送无参数 system open，并显示实际后端", async () => {
  const { host, ws } = await mountApp();
  await emit(ws, boundMessage());
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="在系统终端打开并继续当前会话"]');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(ws.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === "terminal.open"))
    .toEqual([{ type: "terminal.open", mode: "system" }]);
  await emit(ws, { type: "terminal.opened", leaseId: LEASE_ID, mode: "system", backend: "windows-console" });
  expect(host.textContent).toContain("已回退到系统控制台");
});

it("接管时禁用写操作并保留草稿，idle 后恢复", async () => {
  const { host, ws } = await mountApp();
  await emit(ws, boundMessage());
  await emit(ws, { type: "chat.draft", text: "接管前草稿" });
  await emit(ws, terminalState("active"));
  expect(host.textContent).toContain("终端接管中 · 当前为只读镜像 · 终端退出后恢复输入");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("接管前草稿");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  expect(host.querySelector<HTMLSelectElement>('select[title="权限模式"]')?.disabled).toBe(true);
  await emit(ws, terminalState("idle"));
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("接管前草稿");
});

it("镜像更新同一工具行，旧 revision 和旧 sessionId 不覆盖新会话", async () => {
  const { host, ws } = await mountApp();
  await emit(ws, boundMessage(SID_1));
  await emit(ws, terminalState("active", SID_1));
  await emit(ws, mirror(SID_1, 1, runningTool));
  await emit(ws, mirror(SID_1, 2, successfulTool));
  expect(host.querySelectorAll(".tool-activity")).toHaveLength(1);
  expect(host.querySelector(".tool-status")?.textContent).toBe("已完成");
  await emit(ws, boundMessage(SID_2, true));
  await emit(ws, mirror(SID_1, 999, oldTool));
  expect(host.querySelector(".message-list")?.textContent).not.toContain("旧会话工具");
});

it("degraded 明示不能可靠跟随，terminal.error 在详情外可见", async () => {
  const { host, ws } = await mountApp();
  await emit(ws, terminalState("degraded", SID_1));
  expect(host.textContent).toContain("不能可靠跟随");
  await emit(ws, { type: "terminal.error", code: "READ_ONLY", message: "终端接管中", leaseId: LEASE_ID });
  expect(host.querySelector(".terminal-error")?.textContent).toContain("终端接管中");
});
```

输入框和 AliasBar/FolderBar 组件测试还要断言新建、删除、切换、换绑、审批/Ask 回答全部 disabled；历史分页、复制和展开未禁用。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix extension test -- tests/app-tool-flow.test.tsx tests/input-box.test.tsx`
Expected: FAIL，系统终端按钮不存在，只读 banner/禁用逻辑和 terminal 消息分支不存在。

- [x] **Step 3: 实现状态处理和镜像 reducer 接线**

App 增加：

```ts
const [terminal, setTerminal] = useState<TerminalPublicState>({
  leaseId: null, mode: null, phase: "idle", folder: null,
  initialSessionId: null, currentSessionId: null, backend: null, canManualRelease: false,
});
const [terminalError, setTerminalError] = useState("");
const terminalControlled = terminal.phase !== "idle";
const mirrorRef = useRef<TerminalMirrorView>({ sessionId: null, revision: 0, messages: [], hasLoadedOlder: false });
const sessionIdRef = useRef<string | null>(null);
function commitSessionId(next: string | null): void {
  sessionIdRef.current = next; // 长寿命 WS 回调同步可读，不能闭包读取首轮 React state
  setSessionId(next);
}
```

把现有 `folder.bound`、`session.list.data`、`chat.done` 和换绑清理中的 `setSessionId` 全部替换为 `commitSessionId`。

消息分支：

```ts
case "terminal.state":
  setTerminal(m.state);
  if (m.state.phase === "idle") setTerminalError("");
  break;
case "terminal.opened":
  setTerminalError(m.backend === "windows-console"
    ? "未检测到 Windows Terminal，已回退到系统控制台"
    : "终端已打开，插件进入只读镜像");
  break;
case "terminal.error":
  setTerminalError(m.message);
  break;
case "session.mirror.data": {
  const next = reduceTerminalMirror(mirrorRef.current, m, sessionIdRef.current);
  if (next === mirrorRef.current) break;
  mirrorRef.current = next;
  setMessages(next.messages);
  if (!next.hasLoadedOlder) {
    setHistoryCursor(m.nextCursor ?? null);
    setHasOlderHistory(m.hasMore && Boolean(m.nextCursor));
  }
  break;
}
```

分页应答到达时把 `mirrorRef.current.hasLoadedOlder=true`，且同步 `mirrorRef.current.messages`，避免下一帧镜像用旧数组覆盖分页。`folder.bound` 在 `commitSessionId` 后还要把 `mirrorRef.current.sessionId` 更新为新会话、revision 归零；只有会话变化才清空其消息，compact 的同会话 bound 不清空。

- [x] **Step 4: 实现控件只读并运行 GREEN**

AliasBar 增加 `terminalControlled: boolean`、`onOpenSystemTerminal(): void`、`terminalNotice: string | null`。`>_` 按钮使用准确 aria-label，未绑定或接管中禁用；接管中显示 banner，身份 unknown 时显示 `window.confirm("请确认原系统终端已经关闭。解除后不会尝试结束任何进程。是否继续？")` 的人工解除按钮，确认后发送 `terminal.release`。

FolderBar 增加 `disabled`，只禁用输入、绑定、新建/删除/切换；复制 resume 命令仍可用。InputBox 增加 `readOnly`，将所有设置、上传、发送控件和 textarea 禁用，但不把 `busy` 伪造成 true，因此不显示“停止本轮生成”。四张交互卡增加 `disabled` 并在 App 的回调最前面检查 `terminalControlled`，服务端 guard 仍是最终防线。

样式新增：

```css
.terminal-readonly,
.terminal-error { padding: 6px 10px; font-size: 12px; line-height: 1.5; }
.terminal-readonly { color: #8a5a00; background: #fff7df; border-bottom: 1px solid #ead9a8; }
.terminal-error { color: #a40000; background: #fff0f0; border-bottom: 1px solid #efc0c0; }
.alias-bar-row button[aria-label="在系统终端打开并继续当前会话"] { font-family: ui-monospace, monospace; }
```

Run: `npm --prefix extension test -- tests/app-tool-flow.test.tsx tests/input-box.test.tsx && npm --prefix extension test && npm --prefix extension run typecheck && npm --prefix extension run build`
Expected: 新增 UI 测试和扩展完整测试 0 failures，typecheck/build exit 0；既有工具详情、compact、Task 回放测试不回归。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add extension/src/entrypoints/sidepanel/App.tsx extension/src/components extension/src/entrypoints/sidepanel/style.css extension/tests/app-tool-flow.test.tsx extension/tests/input-box.test.tsx
git commit -m "展示系统终端接管与只读历史镜像"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 8: 假 CLI、编译产物和真实 Windows 验收

**Files:**
- Create: `bridge/scripts/fake-terminal-claude.ts`
- Create: `bridge/scripts/verify-system-terminal.mjs`
- Modify: `README.md`, `docs/guide.md`, `docs/development.md`, `TODO.md`（执行前逐项取得用户确认）
- Evidence: `D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\system-verification.json`

**Interfaces:**
- 假 CLI 支持真实进程参数和交互命令，但不导入 SDK、不访问网络 API；只向 settings 中的本机 hook URL 发 HTTP。
- 验收记录必须区分“自动测试证据”“真实 Chrome/窗口证据”“未验收平台”。

- [ ] **Step 1: 先写验收脚本的失败断言**

`verify-system-terminal.mjs` 启动前强制要求三个隔离路径都位于批准根目录，检查当前工作目录不在仓库树内，并以非零退出覆盖以下断言：

```js
const required = {
  windowsTerminalVisible: true,
  fallbackConsoleVisible: true,
  fallbackReported: true,
  resumedInitialSession: true,
  clearFollowedNewSession: true,
  resumeFollowedSelectedSession: true,
  ordinaryExternalSessionListedWithoutTakeover: true,
  compactKeptSessionAndCollapsedSummary: true,
  taskReportCollapsed: true,
  sidepanelReadonly: true,
  popupReadonly: true,
  directWriteRequestsRejected: true,
  exitRestoredLastHookSession: true,
  degradedStayedReadonly: true,
  restartRecoveredSystemLease: true,
  unknownIdentityRequiredManualRelease: true,
  compiledExeOutsideProjectTree: true,
  realApiCalled: false,
};
for (const [name, expected] of Object.entries(required)) {
  if (evidence[name] !== expected) throw new Error(`验收失败: ${name}`);
}
if (evidence.runtimeErrors.length !== 0) throw new Error("Chrome 存在运行错误");
```

假 CLI 从 stdin 支持 `/clear`、`/resume <uuid>`、`/fork`、`/compact`、`exit`，每次 SessionStart 从私有 settings 读取 URL/token 发 Hook，JSONL 写入隔离 `CLAUDE_CONFIG_DIR/projects/<slug>/<sessionId>.jsonl`。额外命令 `/fixture compact`、`/fixture task` 写入与 `transcript.test.ts` 相同的 compact/Task 真实行结构，供 UI 验证默认折叠和完整展开。

- [ ] **Step 2: 运行 RED，证明验收能抓缺失功能**

先对同一完整隔离构建运行验收脚本的负控模式；该模式只让隔离假 CLI 设置 `CCC_FAKE_CLI_DISABLE_HOOKS=1`，不修改生产代码：

Run: `node bridge/scripts/verify-system-terminal.mjs --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\red" --negative-control hooks`
Expected: 非零退出并准确指出 Hook 会话跟随/降级证据缺失；不能把超时、脚本异常或连接失败记作功能通过。此 RED 记录保存在 `red-result.json`，随后不携带负控参数重新运行同一构建。

- [ ] **Step 3: 构建隔离产物并执行真实 Chrome 验收**

Run:

```bash
npm --prefix bridge test
npm --prefix bridge run typecheck
npm --prefix extension test
npm --prefix extension run typecheck
npm --prefix extension run build
node bridge/scripts/build-exe.mjs win
bun build bridge/scripts/fake-terminal-claude.ts --compile --target=bun-windows-x64 --outfile "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\bin\fake-claude.exe"
node bridge/scripts/verify-system-terminal.mjs --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\run-1"
```

验收脚本必须：
1. 在 `run-1\home` 和 `run-1\claude-config` 设置隔离环境，CWD 为 `run-1\cwd`，启动 `dist` 编译 exe 的隔离副本；不得读取用户配置或停止用户桥接。
2. 用真实 Chrome 加载新扩展，打开侧边栏和独立聊天窗口；通过真实按钮启动系统终端。
3. 用 Windows Shell/UI Automation 记录终端顶层窗口 `Visible=true`、标题和目录；spawn/`terminal.opened` 仅作辅助证据。
4. 隐藏 PATH 中的 `wt.exe` 再测回退，确认窗口可见且 UI 明示“已回退到系统控制台”。
5. 在假 CLI 终端依次执行 `/clear`、`/resume`、`/compact`，对比 Hook sessionId、会话列表和两侧聊天视图；另启动不带 lease token 的普通假 CLI，确认只新增列表项、不抢镜像。
6. 直接构造全部写请求，确认 `READ_ONLY`，草稿保留，工具结果、diff、Ask、compact、Task 长文默认折叠且可展开。
7. 关闭终端，确认最终镜像先于 SDK 恢复，恢复最后 Hook sessionId；模拟无 Hook 的存活进程，10 秒后 degraded 仍只读。
8. 重启隔离桥接验证身份匹配恢复、已退出清理和 unknown 人工解除；绝不使用用户进程做异常测试。
9. 收集 Chrome console/pageerror，保存截图和 JSON；不输出 token、环境或 API 配置。

Expected: 所有自动测试 0 failures，构建 exit 0，验收脚本 exit 0，`realApiCalled=false`，`runtimeErrors=[]`。

- [ ] **Step 4: 文档与平台状态**

README 用简短用户语言增加系统终端入口、只读镜像和退出恢复；guide 写清 `/clear`、`/resume` 和 degraded；development 写隔离验证命令与私有文件布局；TODO 记录实际证据路径。macOS 仅写“代码与 CI 覆盖，真实 Terminal.app 尚未验收”，除非确实在 macOS arm64 运行并取得同等证据。

Run: `git diff --check && git status --short`
Expected: 无空白错误；根目录 `ccc-bridge-win-x64.zip` 和 `捕获1.JPG` 仍不纳入变更。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/scripts/fake-terminal-claude.ts bridge/scripts/verify-system-terminal.mjs README.md docs/guide.md docs/development.md TODO.md
git commit -m "验收系统终端续聊与会话同步"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

Expected: 只有用户本人作者/提交者，无共同作者。不得 push、tag 或创建 Release。

## Stage A Exit Checklist

- [ ] 系统终端真实可见，续聊参数正确，回退有明确提示。
- [ ] 普通外部终端新会话自动出现在列表，但不能抢占 lease 镜像。
- [ ] `/clear`、`/resume`、fork、compact 由有效 Hook 驱动；degraded 不猜 sessionId。
- [ ] 两个聊天视图只读、草稿保留、旧分页保留、稳定 ID 去重、长内容默认折叠。
- [ ] 启动失败恢复，进程退出最终同步后恢复，重启身份 unknown 需人工确认。
- [ ] 编译 exe 在项目树外通过验证，未调用真实 API，未影响用户桥接。
- [ ] macOS 未获真实运行证据时明确保持未验收。
- [ ] 继续执行内嵌终端计划；不得把本阶段宣称为全部双终端完成。
