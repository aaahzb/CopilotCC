# CopilotCC 压缩进度可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Claude Code 压缩上下文期间，CopilotCC 顶部状态栏显示“正在压缩…（Xs）”，完成后聊天流插入真实压缩率记录行。

**Architecture:** 桥接会话层把 SDK 的 status/compact_boundary 帧归并成 chat.compact（start/done 两相）广播；server 维护 workspace.compacting 供 chat.sync 快照；扩展 App 驱动状态栏跳秒与记录行。CLI 不输出进度百分比（2.1.301 探针实证），百分比只能在完成后由 1-post/pre 实算。

**Tech Stack:** TypeScript、Vitest、React 19、jsdom、WS、WXT。

## Global Constraints

- 协议单一来源 shared/protocol.ts；修改后必须运行 node scripts/sync-protocol.mjs 同步两端复制件。
- 严格 TDD：先写测试并看到有效 RED（断言失败，不是语法错误），再写实现。
- 除用户明确要求外不 commit、push、tag。
- 不停止、不覆盖用户正在使用的桥接（记录 PID 16852）；真实 exe 验证用隔离 HOME/配置 + 本机 127.0.0.1 假上游，探针文件只放 D:\ccc-fast-final-verify-20261026\tool-history-20261027。
- 时序事实（2026-10-29 探针）：/compact 帧序为 start(t) → done(t+13ms) → compact_boundary(t+17ms)；无百分比字段。

---

### Task 1: 协议 chat.compact 与 chat.sync.compacting

**Files:**
- Modify: shared/protocol.ts（ServerMessage union、chat.sync）
- 生成: bridge/src/protocol.ts、extension/src/lib/protocol.ts（sync-protocol 产出，禁止手改）
- Test: bridge/tests/protocol.test.ts（encode 组追加用例）

**Interfaces:**
- Produces: 服务端消息 { type: "chat.compact"; phase: "start" } 与 { type: "chat.compact"; phase: "done"; result: "success" | "failed"; error?: string; preTokens?: number; postTokens?: number; durationMs?: number }；chat.sync 新增必填 compacting: boolean。

- [x] **Step 1: 写 encode 测试**

在 bridge/tests/protocol.test.ts 的 describe("encode", ...) 组内追加：

```ts
  it("chat.compact 两相帧字段保留", () => {
    const done = encode({ type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    expect(JSON.parse(done)).toEqual({ type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    const start = encode({ type: "chat.compact", phase: "start" });
    expect(JSON.parse(start)).toEqual({ type: "chat.compact", phase: "start" });
  });
```

- [x] **Step 2: 运行确认 RED**

Run: cd bridge && npx vitest run tests/protocol.test.ts
Expected: FAIL —— 对象字面量不满足 ServerMessage 联合类型即有效 RED；若是导入/语法错误则不是，修好测试再跑。

- [x] **Step 3: 协议加消息**

shared/protocol.ts 的 ServerMessage union 中，chat.tool 行之后插入：

```ts
  // chat.compact：CC 上下文压缩进度（status/compact_boundary 帧归并转发；CLI 不输出进度百分比，完成行的压缩率由 1-post/pre 实算）
  | { type: "chat.compact"; phase: "start" }
  | { type: "chat.compact"; phase: "done"; result: "success" | "failed"; error?: string; preTokens?: number; postTokens?: number; durationMs?: number }
```

chat.sync 字段中（draft 之后）追加：

```ts
      /** 工作区正在压缩上下文（视图接入即提示；秒数从接入时刻近似起算） */
      compacting: boolean;
```

- [x] **Step 4: 同步并全绿**

Run: node scripts/sync-protocol.mjs && cd bridge && npx vitest run tests/protocol.test.ts
Expected: PASS；cmp shared/protocol.ts bridge/src/protocol.ts 与 cmp shared/protocol.ts extension/src/lib/protocol.ts 均无输出。

---

### Task 2: 桥接会话层帧归并（核心）

**Files:**
- Modify: bridge/src/claude-session.ts（CompactEvent 类型、SessionEvents、handle() 帧分支、归并辅助、close 清理）
- Test: bridge/tests/claude-session.test.ts

**Interfaces:**
- Consumes: 既有 fakeQuery(script) 测试注入（script 为 SDK 帧数组）。
- Produces: export type CompactEvent（见 Step 3a）；SessionEvents 新增 onCompact(ev: CompactEvent): void。

- [x] **Step 1: 写失败测试**

在 bridge/tests/claude-session.test.ts 追加 describe（文件顶部若无则补 import { setTimeout as sleep } from "node:timers/promises";）：

```ts
describe("压缩进度事件", () => {
  function compactSession(script: unknown[]) {
    const q = fakeQuery(script);
    const compact: unknown[] = [];
    const s = createClaudeSession(".", {
      permissionMode: "auto",
      queryFn: q.fn,
      events: {
        onDelta() {}, onTool() {}, onDone() {}, onRuntime() {}, onError() {}, onAborted() {},
        onPermission() {}, onSessionId() {},
        onCompact: (ev) => compact.push(ev),
      },
    });
    return { s, compact };
  }

  it("compacting 帧立即上报 start", async () => {
    const { s, compact } = compactSession([
      { type: "system", subtype: "status", status: "compacting", session_id: "x" },
    ]);
    await sleep(30);
    s.close();
    expect(compact).toEqual([{ phase: "start" }]);
  });

  it("done 后 boundary 在归并窗口内到达：单次 done 携带元数据", async () => {
    const { s, compact } = compactSession([
      { type: "system", subtype: "status", status: "compacting", session_id: "x" },
      { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "x" },
      { type: "system", subtype: "compact_boundary", session_id: "x",
        compact_metadata: { trigger: "manual", pre_tokens: 156_000, post_tokens: 42_000, duration_ms: 900 } },
    ]);
    await sleep(350); // 250ms 归并窗口 + 余量
    s.close();
    expect(compact).toEqual([
      { phase: "start" },
      { phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000, durationMs: 900 },
    ]);
  });

  it("done 后无 boundary：窗口超时按无元数据下发", async () => {
    const { s, compact } = compactSession([
      { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "x" },
    ]);
    await sleep(350);
    s.close();
    expect(compact).toEqual([{ phase: "done", result: "success" }]);
  });

  it("failed 不等待 boundary 且带 error，只发一次", async () => {
    const { s, compact } = compactSession([
      { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "boom", session_id: "x" },
    ]);
    await sleep(350);
    s.close();
    expect(compact).toEqual([{ phase: "done", result: "failed", error: "boom" }]);
  });
});
```

- [x] **Step 2: 运行确认 RED**

Run: cd bridge && npx vitest run tests/claude-session.test.ts -t "压缩进度事件"
Expected: FAIL —— events.onCompact 不是函数或类型错误；断言失败即有效 RED。

- [x] **Step 3: 实现归并**

bridge/src/claude-session.ts 三处修改：

a) SessionRuntimeInfo 之后加导出类型：

```ts
/** CC 上下文压缩进度事件（status/compact_boundary 帧归并；CLI 不输出进度百分比） */
export type CompactEvent =
  | { phase: "start" }
  | { phase: "done"; result: "success" | "failed"; error?: string; preTokens?: number; postTokens?: number; durationMs?: number };
```

b) SessionEvents 接口 onTool 行之后加：

```ts
  /** 压缩开始/结束（结束帧合并 compact_boundary 元数据；failed 与无 boundary 时缺元数据字段） */
  onCompact(ev: CompactEvent): void;
```

c) createClaudeSession 内 let compactPending = false; 之后加归并状态与辅助：

```ts
  let compactTimer: ReturnType<typeof setTimeout> | null = null; // done→boundary 归并窗口
  let pendingCompactDone: { result: "success" | "failed"; error?: string } | null = null;
  const COMPACT_MERGE_MS = 250; // 探针实证 boundary 晚于 done 约 4ms；250ms 兜住慢帧

  function flushCompactDone(meta?: { preTokens?: number; postTokens?: number; durationMs?: number }): void {
    if (!pendingCompactDone) return;
    if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
    const p = pendingCompactDone;
    pendingCompactDone = null;
    events.onCompact({ phase: "done", result: p.result, ...(p.error ? { error: p.error } : {}), ...(meta ?? {}) });
  }

  function queueCompactDone(msg: Record<string, unknown>): void {
    flushCompactDone(); // 防御异常时序：上一轮挂起未清先落盘
    pendingCompactDone = {
      result: msg.compact_result === "failed" ? "failed" : "success",
      ...(typeof msg.compact_error === "string" && msg.compact_error ? { error: msg.compact_error } : {}),
    };
    compactTimer = setTimeout(() => flushCompactDone(), COMPACT_MERGE_MS); // 窗口内 boundary 未到 → 无元数据裸发
  }

  function mergeCompactBoundary(msg: Record<string, unknown>): void {
    if (!pendingCompactDone) return; // 无挂起 done（纯 boundary 路径）只维持 compactPending，不配发 info
    const meta = msg.compact_metadata as Record<string, unknown> | undefined;
    flushCompactDone({
      ...(typeof meta?.pre_tokens === "number" ? { preTokens: meta.pre_tokens } : {}),
      ...(typeof meta?.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
      ...(typeof meta?.duration_ms === "number" ? { durationMs: meta.duration_ms } : {}),
    });
  }
```

d) handle() 中替换原 compact 帧分支（原 compactPending 置位的那段 if）为三句：

```ts
    if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
      flushCompactDone(); // 新一轮压缩开始：先冲掉挂起的 done 再报 start
      events.onCompact({ phase: "start" });
      return;
    }
    if (msg.type === "system" && msg.subtype === "status" && msg.compact_result !== undefined) {
      compactPending = true; // compact 会把页面上下文压缩掉：本轮 done 时上报，扩展下一轮强制重新附带
      queueCompactDone(msg); // 等 compact_boundary 元数据归并，窗口内未到则裸发
      return;
    }
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      compactPending = true;
      mergeCompactBoundary(msg);
      return;
    }
```

e) close() 中（既有清理 compactPending 的位置）加定时器清理：

```ts
    if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
```

- [x] **Step 4: 运行确认 GREEN + 回归**

Run: cd bridge && npx vitest run tests/claude-session.test.ts
Expected: 全部 PASS（含新增 4 项与既有 compacted 行为回归）。

---

### Task 3: server 接线与 chat.sync 快照

**Files:**
- Modify: bridge/src/server.ts（Workspace 接口与初始化、newSession 事件接线、pushSnapshot、resetInflight）
- Test: bridge/tests/server-mirror.test.ts

**Interfaces:**
- Consumes: Task 2 的 onCompact(ev)；Task 1 的 chat.compact 消息与 chat.sync.compacting。
- Produces: broadcast { type: "chat.compact", ...ev }；chat.sync 携带 compacting。

- [x] **Step 1: 写失败测试**

在 bridge/tests/server-mirror.test.ts 追加（沿用该文件既有两客户端 + createSession 捕获 events 的脚手架）：

```ts
  it("chat.compact 广播到全部视图，chat.sync 快照携带 compacting", async () => {
    // 伪造会话句柄，拿到 opts.events
    let captured: Record<string, (ev: unknown) => void> = {};
    // …用与既有用例相同的 makeServer/createSession 模式创建双客户端连接并绑定文件夹…
    captured.onCompact({ phase: "start" });
    await until(() => bothClientsGot("chat.compact", (m) => m.phase === "start"));
    // 新视图接入
    const third = await connectClient();
    await until(() => third.got("chat.sync", (m) => m.compacting === true));
    captured.onCompact({ phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    await until(() => bothClientsGot("chat.compact", (m) => m.phase === "done" && m.preTokens === 156_000));
  });
```

（脚手架函数名以 server-mirror.test.ts 既有用例为准照搬；若既有文件没有 until/连接辅助，按同文件已有等待模式写。）

- [x] **Step 2: 运行确认 RED**

Run: cd bridge && npx vitest run tests/server-mirror.test.ts -t "chat.compact"
Expected: FAIL —— captured.onCompact 为 undefined（server 未接线）。

- [x] **Step 3: 实现接线**

bridge/src/server.ts：

a) Workspace 接口 busy 字段附近加：

```ts
  /** 工作区正在压缩上下文（chat.sync 快照供中途接入的视图立即提示） */
  compacting: boolean;
```

workspace 初始化字面量加 compacting: false。

b) newSession 的 events 中 onTool 行之后加：

```ts
        onCompact: (ev) => {
          workspace.compacting = ev.phase === "start";
          broadcast({ type: "chat.compact", ...ev });
        },
```

c) pushSnapshot 的 chat.sync 字面量加 compacting: workspace.compacting,（draft 之后）。

d) 重置点：newSession 开头（workspace.runtime = {}; 处）加 workspace.compacting = false;；resetInflight 函数体内加 workspace.compacting = false;。

- [x] **Step 4: 运行确认 GREEN**

Run: cd bridge && npx vitest run tests/server-mirror.test.ts && npm run typecheck
Expected: 全部 PASS。

---

### Task 4: 扩展文案助手 compactRecordText

**Files:**
- Modify: extension/src/lib/format.ts
- Test: extension/tests/format.test.ts

**Interfaces:**
- Produces: export interface CompactRecordMeta { preTokens?: number; postTokens?: number }；export function compactRecordText(result: "success" | "failed", error: string | undefined, meta: CompactRecordMeta | null): string。

- [x] **Step 1: 写失败测试**

extension/tests/format.test.ts 追加：

```ts
describe("compactRecordText", () => {
  it("成功且有元数据：真实压缩率（156000→42000 = -73%）", async () => {
    const { compactRecordText } = await import("../src/lib/format");
    expect(compactRecordText("success", undefined, { preTokens: 156_000, postTokens: 42_000 }))
      .toBe("🗜 已压缩上下文 156k → 42k tokens（-73%）");
  });

  it("成功无元数据：退化文案", async () => {
    const { compactRecordText } = await import("../src/lib/format");
    expect(compactRecordText("success", undefined, null)).toBe("🗜 已压缩上下文");
  });

  it("失败：带原因并说明继续使用当前上下文", async () => {
    const { compactRecordText } = await import("../src/lib/format");
    expect(compactRecordText("failed", "boom", null)).toBe("⚠️ 上下文压缩失败：boom，继续使用当前上下文");
    expect(compactRecordText("failed", undefined, null)).toBe("⚠️ 上下文压缩失败，继续使用当前上下文");
  });

  it("小 token 数不走 k 缩写；pre 为 0 不出百分比", async () => {
    const { compactRecordText } = await import("../src/lib/format");
    expect(compactRecordText("success", undefined, { preTokens: 500, postTokens: 400 }))
      .toBe("🗜 已压缩上下文 500 → 400 tokens（-20%）");
    expect(compactRecordText("success", undefined, { preTokens: 0, postTokens: 0 }))
      .toBe("🗜 已压缩上下文 0 → 0 tokens");
  });
});
```

- [x] **Step 2: 运行确认 RED**

Run: cd extension && npx vitest run tests/format.test.ts
Expected: FAIL —— compactRecordText 不存在。

- [x] **Step 3: 实现**

extension/src/lib/format.ts 追加：

```ts
/** 压缩记录行可用的元数据子集（chat.compact done 帧归并后） */
export interface CompactRecordMeta {
  preTokens?: number;
  postTokens?: number;
}

/** tokens 紧凑显示：>=1000 用 k（156000 → "156k"） */
function compactTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

/**
 * 压缩完成后的聊天记录行文案。CLI 全程无进度百分比；压缩率 = 1 - post/pre 在完成后才可实算。
 * @param result 压缩结果
 * @param error 失败原因（成功时为 undefined）
 * @param meta 元数据；null 或缺 token 字段（老 CLI / boundary 丢失）时退化简单文案
 * @returns 记录行文本（🗜 成功 / ⚠️ 失败前缀）
 */
export function compactRecordText(result: "success" | "failed", error: string | undefined, meta: CompactRecordMeta | null): string {
  if (result === "failed") return `⚠️ 上下文压缩失败${error ? `：${error}` : ""}，继续使用当前上下文`;
  if (meta?.preTokens === undefined || meta?.postTokens === undefined) return "🗜 已压缩上下文";
  const pct = meta.preTokens > 0 ? Math.max(0, Math.round((1 - meta.postTokens / meta.preTokens) * 100)) : null;
  const ratio = pct !== null && pct > 0 ? `（-${pct}%）` : "";
  return `🗜 已压缩上下文 ${compactTokens(meta.preTokens)} → ${compactTokens(meta.postTokens)} tokens${ratio}`;
}
```

- [x] **Step 4: 运行确认 GREEN**

Run: cd extension && npx vitest run tests/format.test.ts
Expected: PASS。

---

### Task 5: 扩展 App 状态栏提示与记录行

**Files:**
- Modify: extension/src/entrypoints/sidepanel/App.tsx（compacting 状态、chat.compact 分支、chat.sync 恢复、清理点、状态栏 JSX）
- Modify: extension/src/entrypoints/sidepanel/style.css（.conn .compact-hint）
- Test: extension/tests/app-tool-flow.test.tsx（沿用 FakeWebSocket 脚手架追加用例）

**Interfaces:**
- Consumes: Task 1 chat.compact/chat.sync.compacting；Task 4 compactRecordText。
- Produces: 状态栏“正在压缩…（Xs）”；记录行为 role: "tool" 无 toolName 的既有附带状态行（MessageList 零改动）。

- [x] **Step 1: 写失败测试**

extension/tests/app-tool-flow.test.tsx 追加（沿用文件内 FakeWebSocket 与渲染辅助）：

```ts
describe("压缩进度显示", () => {
  it("start 后状态栏出现“正在压缩”，done 插入记录行并清除提示", async () => {
    // 打开已绑定工作区的 App（照既有用例走完 auth.ok/folder.bound/history/chat.sync）
    ws.emit({ type: "chat.compact", phase: "start" });
    await act(async () => {});
    expect(rootContains("正在压缩…（0s）")).toBe(true);
    ws.emit({ type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    await act(async () => {});
    expect(rootContains("🗜 已压缩上下文 156k → 42k tokens（-73%）")).toBe(true);
    expect(rootContains("正在压缩…")).toBe(false);
  });

  it("failed 插入失败记录行", async () => {
    ws.emit({ type: "chat.compact", phase: "done", result: "failed", error: "boom" });
    await act(async () => {});
    expect(rootContains("⚠️ 上下文压缩失败：boom，继续使用当前上下文")).toBe(true);
  });

  it("chat.sync.compacting=true 时状态栏有提示", async () => {
    // 重连场景：重新走快照，chat.sync 带 compacting: true
    expect(rootContains("正在压缩…")).toBe(true);
  });

  it("断线清除压缩提示", async () => {
    ws.emit({ type: "chat.compact", phase: "start" });
    await act(async () => {});
    ws.close();
    await act(async () => {});
    expect(rootContains("正在压缩…")).toBe(false);
  });
});
```

（rootContains 之类辅助以 app-tool-flow.test.tsx 既有断言风格为准。）

- [x] **Step 2: 运行确认 RED**

Run: cd extension && npx vitest run tests/app-tool-flow.test.tsx -t "压缩进度显示"
Expected: FAIL —— chat.compact 帧被忽略 / compacting 提示不存在。

- [x] **Step 3: 实现**

extension/src/entrypoints/sidepanel/App.tsx：

a) 状态与跳秒（组件内、conn 状态声明附近）：

```tsx
  const [compactSince, setCompactSince] = useState<number | null>(null); // 压缩开始时刻；null=未在压缩
  const [compactTick, setCompactTick] = useState(0); // 每秒 +1 触发重渲染以刷新秒数
  useEffect(() => {
    if (compactSince === null) return;
    const timer = window.setInterval(() => setCompactTick((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [compactSince]);
  void compactTick; // 秒数显示依赖它触发重算
```

b) 消息 switch 中 chat.tool 分支之后加：

```tsx
      case "chat.compact":
        if (m.phase === "start") {
          setCompactSince(Date.now());
        } else {
          setCompactSince(null);
          const meta = m.preTokens !== undefined || m.postTokens !== undefined ? { preTokens: m.preTokens, postTokens: m.postTokens } : null;
          const text = compactRecordText(m.result, m.error, meta);
          // role:"tool" 无 toolName → 复用既有附带状态行渲染（紧凑灰行、非气泡），MessageList 零改动
          setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "tool", text }]);
        }
        break;
```

c) chat.sync 分支内 setBusy(m.busy) 之后加：

```tsx
        setCompactSince(m.compacting ? Date.now() : null); // 快照权威：接入时刻近似起算秒数
```

d) 清理点（与 setBusy(false) 同处）：chat.error 分支、chat.aborted 分支、folder.bound 的 reset 分支、ws onclose 的 setConn 处（connect() 内 if (state !== "open") setBusy(false) 旁）各加 setCompactSince(null);。

e) 状态栏 JSX（.conn div 内）改为：

```tsx
      <div className={`conn ${conn}`}>
        <span>{conn === "open" ? "● 已连接" : conn === "connecting" ? "● 连接中…" : "● 已断开（自动重连中）"}</span>
        {conn === "open" && compactSince !== null ? (
          <span className="compact-hint">正在压缩…（{Math.floor((Date.now() - compactSince) / 1000)}s）</span>
        ) : null}
      </div>
```

f) style.css .conn 规则附近加：

```css
.conn .compact-hint { margin-left: 8px; color: #d9a400; }
```

- [x] **Step 4: 运行确认 GREEN + 回归**

Run: cd extension && npx vitest run tests/app-tool-flow.test.tsx && npm run typecheck
Expected: 全部 PASS。

---

### Task 6: 文档与真实全链验证

**Files:**
- Modify: README.md（压缩可见性说明）、TODO.md（验收记录）
- Create: D:\ccc-fast-final-verify-20261026\tool-history-20261027\exe-chrome-compact-probe.cjs（改自 exe-chrome-live-probe.cjs）

- [x] **Step 1: 两端全量回归**

Run: cd bridge && npm test && npm run typecheck && npm run selftest；cd extension && npm test && npm run typecheck
Expected: 全绿（桥接 196+新增、扩展 89+新增）。

- [x] **Step 2: 真实全链探针**

复制 exe-chrome-live-probe.cjs 为 exe-chrome-compact-probe.cjs：假上游对 /v1/messages 一律回文本；扩展绑定后通过 WS 发 chat.send "/compact"；断言 Chrome DOM：状态栏出现“正在压缩…”，随后出现“🗜 已压缩上下文 …”记录行，runtimeErrors 为空。探针只连 127.0.0.1，不碰真实中转。

Run: node D:/ccc-fast-final-verify-20261026/tool-history-20261027/exe-chrome-compact-probe.cjs
Expected: COMPACT_PROBE_OK=true。

- [x] **Step 3: 更新文档**

README.md 功能说明补“压缩进度可见性”段落；TODO.md 记录探针结果与遗留项（用户真实长会话 auto-compact 中的人工视觉复核留给用户）。
