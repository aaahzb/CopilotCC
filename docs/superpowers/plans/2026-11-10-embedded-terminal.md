# Embedded xterm.js and PTY Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 A 的共用 lease/hooks/watcher 之上交付独立 Chrome 终端窗口、真实 PTY、输入输出与 resize、短暂重连、退出清理和可发布的原生运行包。

**Architecture:** `terminal.html` 只负责 xterm.js 和已认证 WebSocket，桥接独占 PTY 生命周期；原始 ANSI 数据块带 leaseId/seq 只发终端连接，结构化聊天仍由阶段 A 的 JSONL 镜像提供。先用真实编译产物决定 Bun 直接 node-pty 或随包 Node 22 helper，发行构建必须把所选路线的输入、持续输出、中文、resize 和退出探针作为硬门槛。

**Tech Stack:** TypeScript、React 19、Chrome MV3、xterm.js 5.5、node-pty 1.1、ConPTY/POSIX PTY、Bun compile、Node.js 22 helper、Vitest。

## Global Constraints

- 先完成 `2026-11-10-terminal-core-system.md`；本计划复用其 `TerminalStartContext`、`TerminalRuntimeHandle`、`TerminalLeaseManager`、`TerminalService` 和只读镜像，不建立第二套会话系统。
- 仅支持 Windows x64（Windows 10 1809+，ConPTY）和 macOS arm64（POSIX PTY）；Linux、Windows x86、macOS Intel 不在范围内。
- 打开顺序固定：background 打开/聚焦 `terminal.html` → 正常桥接认证 → `terminal.open {mode:"embedded"}` → `terminal.opened` → 同一连接 `terminal.attach`。窗口创建失败不得启动 Claude。
- PTY 原始数据只进入 xterm.js；聊天镜像只来自 JSONL。不得解析 ANSI 生成用户/助手消息，也不承诺逐字聊天镜像。
- 初次/重连 attach 使用递增 seq 和有界重放；无法补齐缺口必须报错并结束终端，不能静默丢输出或伪造连续屏幕。
- 客户端断开给予 3 秒宽限；只有原页面内存中的 attachToken 能重连。刷新后的新页面不保存/恢复 attachToken，不恢复原屏幕。
- 页面关闭、刷新、重连超时、输出缺口和明确的结束按钮最终都结束自己拥有的 PTY；转录保留。
- 桥接正常退出结束其 PTY。异常重启不续接内嵌终端；仅进程 PID、程序路径、启动时间全部匹配时清理遗留子进程，身份不明则保持只读并要求人工确认，不能按 PID 猜测杀进程。
- 原生 PTY 不可用时只让插件终端失败，系统终端和普通聊天继续可用；错误不含 token、API key 或进程环境。
- 不要求用户安装 Node；若直接 Bun 路线失败，发行包必须携带 Node 22 helper 和完整原生依赖。
- 不自动 commit、push、tag 或发布。提交命令仅在用户另行授权后执行；作者和提交者只能是用户本人，禁止共同作者尾注。
- 修改已有文件前逐项取得用户确认；所有新文件 UTF-8；严格先有效 RED 再 GREEN。
- 不停止或替换用户桥接，不调用真实 API。隔离验证只使用阶段 A 假 CLI 和 `D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110`。
- 编译 exe 必须在项目树外、隔离 CWD/`CCC_BRIDGE_HOME`/`CLAUDE_CONFIG_DIR` 验证；`--smoke` 不足以证明 PTY 可用。
- 没有真实 macOS arm64 运行和签名证据时，macOS 保持“未验收”。

---

## File Map

- Create `bridge/src/pty-backend.ts`：统一 PTY 进程接口、后端类型和加载错误。
- Create `bridge/src/bun-pty-backend.ts`：Bun 外部 `createRequire` 加载 node-pty。
- Create `bridge/src/node-pty-helper.ts`：回退 helper 的 JSON-lines stdin/stdout 协议。
- Create `bridge/src/node-pty-backend.ts`：主桥接管理 helper 进程和请求 ID。
- Create `bridge/src/terminal-output-buffer.ts`：1 MiB/256 块有界输出、seq 和缺口判断。
- Create `bridge/src/embedded-terminal.ts`：CLI 参数、PTY runtime、输入/resize/kill、连接断开宽限。
- Create `extension/src/entrypoints/terminal/index.html`, `main.tsx`, `TerminalApp.tsx`, `terminal.css`：独立终端页。
- Create `extension/src/lib/terminal-client.ts`：认证后的 open/attach、输出序号、输入、resize 和重连状态。
- Modify `extension/src/lib/popup-registry.ts`, `extension/src/entrypoints/background.ts`：终端窗口去重和聚焦，不复用聊天网页钉住参数。
- Modify `shared/protocol.ts` 并同步两份复制件：attach/input/resize/output/attached/exit。
- Modify `bridge/src/server.ts`, `terminal-service.ts`, `index.ts`, `tray.ts`：连接所有权和关闭清理。
- Modify `bridge/scripts/build-exe.mjs`, `build-mac-app.sh`, `.github/workflows/ci.yml`, `release.yml`：原生文件布局、helper 回退、签名与硬门槛。

---

### Task 1: 原生依赖与真实 PTY 路线探针

**Files:**
- Modify: `bridge/package.json`, `bridge/package-lock.json`
- Create: `bridge/scripts/pty-probe-child.cjs`
- Create: `bridge/scripts/probe-bun-node-pty.ts`
- Create: `bridge/scripts/run-pty-probe.mjs`
- Evidence: 验证根目录下 `pty-route.json`

**Interfaces:**
- Produces: 路线值 `bun-node-pty` 或 `node-helper`，由编译产物探针结果决定。
- `--route auto` 固定先跑 Bun 直接探针，失败才运行 helper；`pty-route.json` 同时保存两条路线的 pass/fail 阶段，构建只读取通过项，不能在打包时静默换路线。
- 探针固定验收：输入回显、至少 5 个连续 tick、中文、132×36 resize、退出码 7；只加载模块不算通过。

- [ ] **Step 1: 安装锁定依赖并写探针子进程**

```bash
npm --prefix bridge install --save-exact node-pty@1.1.0
```

node-pty 1.1.0 使用包内 `typings/node-pty.d.ts`；构建时运行 `npm --prefix bridge run typecheck` 验证该类型入口，不另装可能冲突的 `@types/node-pty`，也不用 `any` 隐藏原生接口错误。

2026-11-10 实机构建证据将原定 1.0.0 修正为当前稳定版 1.1.0：旧版在本机缺 Spectre 库且随后出现 ConPTY 声明/MSVC 源码错误；1.1.0 改用 N-API，并在已核验 SHA-512 与路径安全的 npm 包内提供 win32-x64/win32-arm64/darwin-arm64 预编译文件。使用预编译文件不替代真实行为探针，发行布局仍必须包含其所有配套 DLL/helper，不能只复制 `.node`。

`pty-probe-child.cjs` 是探针专用 Node 子进程，不进入发行包：

```js
"use strict";
const readline = require("node:readline");
console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
process.stdout.on("resize", () => console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`));
let ticks = 0;
const timer = setInterval(() => console.log(`TICK:${++ticks}`), 100);
readline.createInterface({ input: process.stdin, terminal: true }).on("line", (line) => {
  if (line === "ECHO") console.log("中文输出:你好");
  if (line === "EXIT") { clearInterval(timer); process.exit(7); }
});
```

探针使用 `createRequire(path.join(executableDir, "pty", "package.json"))("node-pty")`，以便编译 exe 从同目录 `pty/node_modules` 解析外置包；spawn `PROBE_NODE` 指定的 Node 22、参数为探针 child 的绝对路径，初始 80×24。收集输出直到包含 `中文输出:你好`、`TICK:5` 和 `SIZE:132x36`，再发送 `EXIT\r`，断言退出码 7。每阶段超时 8 秒，失败时只记录错误类型/阶段，不输出环境。

- [ ] **Step 2: 在项目树外运行 RED**

Run:

```bash
node bridge/scripts/run-pty-probe.mjs --route bun --target win --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\pty-red"
```

`run-pty-probe.mjs` 先编译 `probe-bun-node-pty.ts`，复制 exe、探针 child 到 `pty-red`，并把 node-pty 复制到 `pty-red\pty\node_modules\node-pty`，从 `pty-red\cwd` 执行，设置 `PROBE_NODE` 为 CI 的 Node 22 绝对路径。

Expected: 在探针实现完成前 RED，明确失败于 probe 模块/原生加载/行为断言之一；若意外全部通过，检查是否真的从隔离目录启动且没有读取仓库 `node_modules`。

- [ ] **Step 3: 完成直接路线探针并决定路线**

探针核心代码：

```ts
const pty = externalRequire("node-pty") as typeof import("node-pty");
const term = pty.spawn(process.env.PROBE_NODE!, [childPath], {
  name: "xterm-256color", cols: 80, rows: 24,
  cwd: probeCwd, env: process.env,
});
term.onData((data) => { output += data; process.stdout.write(data); });
const exit = new Promise<number>((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)));
await waitFor(() => output.includes("SIZE:80x24"));
term.write("ECHO\r");
await waitFor(() => output.includes("中文输出:你好") && output.includes("TICK:5"));
term.resize(132, 36);
await waitFor(() => output.includes("SIZE:132x36"));
term.write("EXIT\r");
if (await exit !== 7) throw new Error("EXIT_CODE");
```

直接路线只有在 Windows x64 真实编译 exe 上全部通过才记录 `bun-node-pty`。macOS 的路线记录只能在 macOS arm64 runner 上生成；Windows 结果不能替代 macOS 结果。

- [ ] **Step 4: 若直接路线失败，运行完整 Node helper 探针**

失败时执行 Task 2 的 helper 实现和 `run-pty-probe.mjs --route helper`，使用同一个 child、同一组输入/输出/resize/退出断言。helper 探针通过才能选择 `node-helper`；两条路线都失败则停止后续终端实现，先按 systematic-debugging 定位原生根因，不能交付只有 xterm 页面的假终端。

直接路线通过时运行：
`node bridge/scripts/run-pty-probe.mjs --route bun --target win --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\pty-green"`

直接路线失败、Task 2 helper 通过时运行：
`node bridge/scripts/run-pty-probe.mjs --route helper --target win --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\pty-green"`

Expected: 实际选择的那条命令 exit 0；`pty-route.json` 记录路线、平台、架构、五项行为均为 true、隔离 CWD 为 true，不含环境或密钥。另一条路线失败必须保留其失败阶段，不得从记录中抹去。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/package.json bridge/package-lock.json bridge/scripts/pty-probe-child.cjs bridge/scripts/probe-bun-node-pty.ts bridge/scripts/run-pty-probe.mjs
git commit -m "增加真实原生终端路线探针"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 2: 统一 PTY 后端与 Node helper 回退

**Files:**
- Create: `bridge/src/pty-backend.ts`
- Create: `bridge/src/bun-pty-backend.ts`
- Create: `bridge/src/node-pty-helper.ts`
- Create: `bridge/src/node-pty-backend.ts`
- Test: `bridge/tests/pty-backend.test.ts`
- Test: `bridge/tests/node-pty-helper.test.ts`

**Interfaces:**
- Produces: `PtyBackend.spawn(options): Promise<PtyProcess>`，屏蔽直接/helper 差异。
- Produces: `createPtyBackend(kind, executableDir)`，主服务只依赖该接口。

- [x] **Step 1: 写后端契约失败测试**

用可注入 fake pty module/helper child，测试真实适配器代码：

```ts
it("统一数据、退出、输入、resize 和关闭事件", async () => {
  const backend = new BunPtyBackend({ executableDir: nativeDir, require: () => fakePtyModule });
  const proc = await backend.spawn({ file: "claude", args: ["--resume", SID], cwd: work, cols: 100, rows: 30 });
  expect(proc.pid).toBe(4321);
  proc.write("中文\r");
  proc.resize(132, 36);
  expect(fakePty.write).toHaveBeenCalledWith("中文\r");
  expect(fakePty.resize).toHaveBeenCalledWith(132, 36);
  fakePty.emitData("tool output");
  expect(data).toEqual(["tool output"]);
  fakePty.emitExit(0, null);
  expect(exits).toEqual([{ exitCode: 0, signal: null }]);
});

it("helper 将多行输出按 JSONL 帧分发，启动失败只影响该后端", async () => {
  const backend = new NodePtyBackend({ nodePath, helperPath, spawn: fakeHelperSpawn });
  const pending = backend.spawn(options);
  fakeHelper.stdout.write(JSON.stringify({ type: "started", id: 1, pid: 99 }) + "\n");
  const proc = await pending;
  fakeHelper.stdout.write(JSON.stringify({ type: "data", id: 1, data: "第一行\r\n第二行" }) + "\n");
  expect(proc.pid).toBe(99);
  expect(data.join("")).toBe("第一行\r\n第二行");
  fakeHelper.emitError(new Error("helper exited"));
  expect(backend.closed()).toBe(true);
});

it("kill 幂等且迟到的 helper data 不会进入新进程", async () => {
  const proc = await backend.spawn(options);
  await Promise.all([proc.kill(), proc.kill()]);
  expect(fakePty.kill).toHaveBeenCalledTimes(1);
  fakeHelper.stdout.write(JSON.stringify({ type: "data", id: 1, data: "旧进程" }) + "\n");
  expect(data).toEqual([]);
});
```

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/pty-backend.test.ts tests/node-pty-helper.test.ts`
Expected: FAIL，四个后端模块不存在。

- [x] **Step 3: 实现统一接口与直接后端**

```ts
export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv; // 仅服务端内部用于 command Hook 私有环境，WS 不提供此字段
}

export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal: number | null }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): Promise<void>;
}

export interface PtyBackend {
  readonly kind: "bun-node-pty" | "node-helper";
  spawn(options: PtySpawnOptions): Promise<PtyProcess>;
  close(): Promise<void>;
}
```

`BunPtyBackend` 从 `executableDir/pty/node_modules` 用 `createRequire(path.join(executableDir, "pty", "package.json"))` 加载，spawn 环境使用 `options.env ?? process.env`，不写盘/日志。构造参数为 `{ executableDir: string; require?: (id: "node-pty") => typeof import("node-pty") }`，测试注入 require 时仍传隔离 executableDir。`kill()` 先标记 killed，再调用一次 node-pty kill；迟到 data 被忽略，exit 仍必须分发一次。

工厂实现固定为：

```ts
export function createPtyBackend(kind: PtyBackend["kind"], executableDir: string): PtyBackend {
  if (kind === "bun-node-pty") return new BunPtyBackend({ executableDir });
  return new NodePtyBackend({
    nodePath: path.join(executableDir, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    helperPath: path.join(executableDir, "pty", "helper.cjs"),
  });
}
```

- [x] **Step 4: 实现 Node helper 与主端并运行 GREEN**

helper stdin/stdout 帧类型完整定义如下，raw PTY 数据使用 JSON 字符串，不改码、不拆 UTF-8：

```ts
type HelperRequest =
  | { type: "start"; id: number; options: PtySpawnOptions }
  | { type: "write"; id: number; data: string }
  | { type: "resize"; id: number; cols: number; rows: number }
  | { type: "kill"; id: number };
type HelperResponse =
  | { type: "started"; id: number; pid: number }
  | { type: "data"; id: number; data: string }
  | { type: "exit"; id: number; exitCode: number; signal: number | null }
  | { type: "error"; id: number | null; code: string; message: string };
```

helper 在 `start` 前校验绝对 `cwd`、非空 file、args 为字符串数组、cols 2–500、rows 2–200。主端只传阶段 A 构造的 CLI/参数；helper 不开放 HTTP/WS 端口。每个进程维护递增 id，stdout 用按 `\n` 分割的有界解析器（单帧最大 1 MiB），stderr 只保留不含环境的最后 4 KiB 用于诊断。

发行回退使用 CI Node 22 的 `process.execPath` 复制为 `runtime/node.exe`（macOS 为 `runtime/node`），helper 由 `bun build src/node-pty-helper.ts --target=node --format=cjs --outfile pty/helper.cjs` 生成。helper 从自身目录构造 `createRequire(path.join(helperDir, "package.json"))`，再加载同包 node-pty 的绝对 `lib/index.js` 入口，不要求用户安装 Node。实际证据为 `pty-helper-green-1` 与 `pty-auto-2`；另补 `started` 同批首屏数据的先 RED 后 GREEN 回归。

Run: `npm --prefix bridge test -- tests/pty-backend.test.ts tests/node-pty-helper.test.ts && npm --prefix bridge run typecheck && node bridge/scripts/run-pty-probe.mjs --route helper --target win --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\helper-green"`
Expected: 适配器测试 PASS，类型检查 exit 0；若直接路线已选择，helper 探针仍在 CI 运行以保证回退不退化，真实行为探针 exit 0。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/pty-backend.ts bridge/src/bun-pty-backend.ts bridge/src/node-pty-helper.ts bridge/src/node-pty-backend.ts bridge/tests/pty-backend.test.ts bridge/tests/node-pty-helper.test.ts bridge/scripts/run-pty-probe.mjs
git commit -m "实现真实终端后端与运行时回退"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 3: 输出 seq、有界重放和严格终端协议

**Files:**
- Create: `bridge/src/terminal-output-buffer.ts`
- Modify: `shared/protocol.ts`
- Generate: `bridge/src/protocol.ts`, `extension/src/protocol.ts`
- Test: `bridge/tests/terminal-output-buffer.test.ts`
- Modify: `bridge/tests/protocol.test.ts`

**Interfaces:**
- Produces: `TerminalOutputBuffer.append/since/latestSeq/clear`。
- Produces: `terminal.attach {leaseId,attachToken,afterSeq}`、`terminal.input`、`terminal.resize`。
- Produces: `terminal.attached`、`terminal.output`、`terminal.exit`。

- [x] **Step 1: 写缓冲和协议失败测试**

```ts
it("seq 连续，按 afterSeq 重放且不错发前一块", () => {
  const buffer = new TerminalOutputBuffer({ maxBytes: 1024, maxChunks: 4 });
  expect(buffer.append("a")!.seq).toBe(1);
  buffer.append("中文");
  expect(buffer.since(1)).toEqual({ gap: false, latestSeq: 2, chunks: [{ seq: 2, data: "中文" }] });
  expect(buffer.since(2)).toEqual({ gap: false, latestSeq: 2, chunks: [] });
  expect(() => buffer.since(3)).toThrow("FUTURE_SEQ");
});

it("超过字节/块数限制报告缺口，未来 attach 不错误接受", () => {
  const buffer = new TerminalOutputBuffer({ maxBytes: 8, maxChunks: 2 });
  buffer.append("1234"); buffer.append("5678"); buffer.append("90");
  expect(buffer.since(0).gap).toBe(true);
  expect(buffer.since(0).chunks.map((c) => c.seq)).toEqual([2, 3]);
  expect(buffer.latestSeq()).toBe(3);
});

it("输入/resize/attach 严格限制字段和范围", () => {
  const parse = (message: unknown) => parseClientMessage(JSON.stringify(message));
  const LEASE_ID = "11111111-1111-4111-8111-111111111111";
  const TOKEN = "A".repeat(43);
  expect(parse({ type: "terminal.input", leaseId: LEASE_ID, data: "中文\r" })).toMatchObject({ data: "中文\r" });
  expect(parse({ type: "terminal.input", leaseId: LEASE_ID, data: "x".repeat(65537) })).toBeNull();
  expect(parse({ type: "terminal.resize", leaseId: LEASE_ID, cols: 132, rows: 36 })).not.toBeNull();
  expect(parse({ type: "terminal.resize", leaseId: LEASE_ID, cols: 1, rows: 36 })).toBeNull();
  expect(parse({ type: "terminal.attach", leaseId: LEASE_ID, attachToken: TOKEN, afterSeq: 4 })).not.toBeNull();
  expect(parse({ type: "terminal.attach", leaseId: LEASE_ID, attachToken: TOKEN, afterSeq: -1 })).toBeNull();
});
```

输入上限按 UTF-8 byte 长度 65,536，不按 UTF-16 code unit；测试用 `"中".repeat(21_846)` 越界，避免 ASCII 测试漏判。attachToken 固定 43 字符 base64url，afterSeq 为 0 到 `Number.MAX_SAFE_INTEGER` 的安全整数。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/terminal-output-buffer.test.ts tests/protocol.test.ts`
Expected: FAIL，buffer 不存在且新帧返回 null。

- [x] **Step 3: 实现 buffer 与协议**

```ts
export interface OutputChunk { seq: number; data: string }
export interface ReplayPage { gap: boolean; latestSeq: number; chunks: OutputChunk[] }

export class TerminalOutputBuffer {
  private chunks: OutputChunk[] = [];
  private bytes = 0;
  private seq = 0;
  constructor(private readonly limits = { maxBytes: 1_048_576, maxChunks: 256 }) {}
  append(data: string): OutputChunk | null {
    if (data.length === 0) return null;
    const chunk = { seq: ++this.seq, data };
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(data, "utf8");
    this.trim();
    return chunk;
  }
  since(afterSeq: number): ReplayPage {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > this.seq) throw new Error("FUTURE_SEQ");
    const first = this.chunks[0];
    return {
      gap: afterSeq > 0 && this.chunks.length > 0 && first!.seq > afterSeq + 1
        || afterSeq === 0 && this.chunks.length > 0 && first!.seq !== 1,
      latestSeq: this.seq,
      chunks: this.chunks.filter((chunk) => chunk.seq > afterSeq),
    };
  }
  latestSeq(): number { return this.seq; }
  clear(): void { this.chunks = []; this.bytes = 0; }
  private trim(): void {
    while (this.chunks.length > 1 && (this.bytes > this.limits.maxBytes || this.chunks.length > this.limits.maxChunks)) {
      const removed = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(removed.data, "utf8");
    }
  }
}
```

单块超过 1 MiB 时保留该最新块，`gap` 对旧序号成立；不得截断 UTF-8 字符串。`clear` 不重置 seq，防止关闭过程中的迟到包复用序号。

协议新增：

```ts
// ClientMessage
| { type: "terminal.attach"; leaseId: string; attachToken: string; afterSeq: number }
| { type: "terminal.input"; leaseId: string; data: string }
| { type: "terminal.resize"; leaseId: string; cols: number; rows: number }
// ServerMessage
| { type: "terminal.attached"; leaseId: string; replayGap: boolean; latestSeq: number }
| { type: "terminal.output"; leaseId: string; seq: number; data: string }
| { type: "terminal.exit"; leaseId: string; exitCode: number | null; reason: string }
```

给 `terminal.opened` 增加可选 `attachToken?: string`，只在 embedded 的定向响应中出现，禁止加入公开 state。`TerminalErrorCode` 增加 `"OUTPUT_GAP" | "PTY_UNAVAILABLE" | "ATTACH_REQUIRED" | "DETACHED"`。

- [x] **Step 4: 同步并运行 GREEN**

Run: `node scripts/sync-protocol.mjs && npm --prefix bridge test -- tests/terminal-output-buffer.test.ts tests/protocol.test.ts && npm --prefix extension test -- tests/protocol.test.ts && npm --prefix bridge run typecheck`
Expected: 重放缺口、UTF-8 限制、行列范围和 attachToken 解析全部 PASS。若扩展没有 protocol 测试文件，只运行现有协议同步测试与 `npm --prefix extension run typecheck`，不创建空测试。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add shared/protocol.ts bridge/src/protocol.ts extension/src/lib/protocol.ts bridge/src/terminal-output-buffer.ts bridge/tests/terminal-output-buffer.test.ts bridge/tests/protocol.test.ts
git commit -m "定义终端输入输出与断线重放协议"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 4: Embedded runtime、连接所有权和 3 秒重连

**Files:**
- Create: `bridge/src/embedded-terminal.ts`
- Modify: `bridge/src/terminal-service.ts`, `bridge/src/server.ts`, `bridge/src/index.ts`, `bridge/src/tray.ts`
- Test: `bridge/tests/embedded-terminal.test.ts`
- Test: `bridge/tests/server-embedded-terminal.test.ts`

**Interfaces:**
- Consumes: Task 2 `PtyBackend`、Task 3 buffer、阶段 A runtime/lease。
- Produces: `EmbeddedTerminalAdapter` 和 `EmbeddedSession`，提供 `attach/detach/write/resize/stop/close`。
- Produces: `TerminalService.openEmbedded(ws)`、`attach(ws,...)`、`disconnect(ws)`。

- [x] **Step 1: 写真实服务失败测试**

```ts
type OpenedWithToken = Extract<ServerMessage, { type: "terminal.opened" }> & { attachToken: string };

it("opened 前不写 PTY，初次 attach 重放已缓冲输出且只发所属连接", async () => {
  const fixture = await bootEmbedded();
  fixture.ws.send(JSON.stringify({ type: "terminal.open", mode: "embedded" }));
  const opened = await fixture.inbox.waitFor("terminal.opened") as OpenedWithToken;
  expect(fixture.pty.options.args.slice(0, 2)).toEqual(["--resume", SID_1]);
  fixture.pty.emitData("before attach");
  expect(fixture.inbox.filter("terminal.output")).toHaveLength(0);
  fixture.other.send(JSON.stringify({ type: "terminal.attach", leaseId: opened.leaseId, attachToken: opened.attachToken, afterSeq: 0 }));
  expect(await fixture.otherInbox.waitFor("terminal.error")).toMatchObject({ code: "NOT_OWNER" });
  fixture.ws.send(JSON.stringify({ type: "terminal.attach", leaseId: opened.leaseId, attachToken: opened.attachToken, afterSeq: 0 }));
  expect(await fixture.inbox.waitFor("terminal.output")).toMatchObject({ seq: 1, data: "before attach" });
});

it("input/resize 只能来自 attached owner，非法连接不改变 PTY", async () => {
  const fixture = await attachedEmbedded();
  for (const sender of [fixture.other]) {
    sender.send(JSON.stringify({ type: "terminal.input", leaseId: LEASE_ID, data: "bad" }));
    sender.send(JSON.stringify({ type: "terminal.resize", leaseId: LEASE_ID, cols: 132, rows: 36 }));
  }
  expect(await fixture.otherInbox.waitCount("terminal.error", 2)).toHaveLength(2);
  expect(fixture.pty.write).not.toHaveBeenCalled();
  fixture.ws.send(JSON.stringify({ type: "terminal.input", leaseId: LEASE_ID, data: "中文\r" }));
  fixture.ws.send(JSON.stringify({ type: "terminal.resize", leaseId: LEASE_ID, cols: 132, rows: 36 }));
  expect(fixture.pty.write).toHaveBeenCalledWith("中文\r");
  expect(fixture.pty.resize).toHaveBeenCalledWith(132, 36);
});

it("3 秒内原 attachToken 新连接可补缺口，普通聊天断开不影响 PTY", async () => {
  vi.useFakeTimers();
  const fixture = await attachedEmbedded();
  fixture.other.close();
  await vi.advanceTimersByTimeAsync(3000);
  expect(fixture.pty.kill).not.toHaveBeenCalled();
  fixture.ws.close();
  fixture.pty.emitData("offline");
  await vi.advanceTimersByTimeAsync(2999);
  expect(fixture.pty.kill).not.toHaveBeenCalled();
  const reconnected = await fixture.connectTerminalPage(openedToken, 1);
  expect(await reconnected.inbox.waitFor("terminal.output")).toMatchObject({ seq: 2, data: "offline" });
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.pty.kill).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("重连超时杀 PTY，最终镜像后恢复；刷新新页面无 token 不能续接", async () => {
  vi.useFakeTimers();
  const fixture = await attachedEmbedded();
  fixture.ws.close();
  await vi.advanceTimersByTimeAsync(3000);
  expect(fixture.pty.kill).toHaveBeenCalledTimes(1);
  fixture.pty.emitExit(0);
  expect(fixture.events.slice(-2)).toEqual(["restore:" + SID_1, "state:idle"]);
  const fresh = await fixture.connectFreshPage();
  fresh.send(JSON.stringify({ type: "terminal.open", mode: "embedded" }));
  expect(fresh.opened.attachToken).not.toBe(openedToken);
  vi.useRealTimers();
});

it("输出缺口明确报错并结束，不伪装连续屏幕", async () => {
  const fixture = await attachedEmbeddedWithTinyBuffer();
  fixture.pty.emitData("1111"); fixture.pty.emitData("2222"); fixture.pty.emitData("3333");
  fixture.ws.close();
  const reconnected = await fixture.connectTerminalPage(openedToken, 0);
  expect(await reconnected.inbox.waitFor("terminal.attached")).toMatchObject({ replayGap: true });
  expect(await reconnected.inbox.waitFor("terminal.error")).toMatchObject({ code: "OUTPUT_GAP" });
  expect(fixture.pty.kill).toHaveBeenCalledTimes(1);
});
```

补充 native 启动失败测试：`PTY_UNAVAILABLE` 只定向终端页，聊天收到 idle，SDK Query 恢复且系统终端适配器仍可启动。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/embedded-terminal.test.ts tests/server-embedded-terminal.test.ts`
Expected: FAIL，embedded adapter/attach 分发和断开计时器不存在。实际结果：2 个 suite 均因 `embedded-terminal` 模块不存在而失败，属于有效 RED。

- [x] **Step 3: 实现 EmbeddedSession 与 runtime**

```ts
export class EmbeddedSession {
  readonly buffer = new TerminalOutputBuffer();
  private owner: WebSocket | null = null;
  private attachToken: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  constructor(
    readonly leaseId: string,
    private readonly pty: PtyProcess,
    private readonly onTimeout: () => void,
  ) {}
  issueAttachToken(): string {
    this.attachToken = randomBytes(32).toString("base64url");
    return this.attachToken;
  }
  attach(ws: WebSocket, token: string, afterSeq: number): ReplayPage {
    if (this.owner && this.owner !== ws) throw new Error("NOT_OWNER");
    if (!this.attachToken || !safeTokenEqual(this.attachToken, token)) throw new Error("NOT_OWNER");
    if (this.owner && this.owner.readyState === WebSocket.OPEN) throw new Error("NOT_OWNER");
    const replay = this.buffer.since(afterSeq);
    this.owner = ws;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    return replay;
  }
  detach(ws: WebSocket): void {
    if (this.owner !== ws) return;
    this.owner = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(this.onTimeout, 3000);
  }
  owns(ws: WebSocket): boolean { return this.owner === ws; }
  assertAttached(ws: WebSocket): void {
    if (this.owner !== ws || ws.readyState !== WebSocket.OPEN) throw new Error("ATTACH_REQUIRED");
  }
  write(ws: WebSocket, data: string): void { this.assertAttached(ws); this.pty.write(data); }
  resize(ws: WebSocket, cols: number, rows: number): void {
    this.assertAttached(ws);
    this.pty.resize(cols, rows);
  }
  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.pty.kill(); // owner 保留到 exit 帧发出，重复 stop 由 PtyProcess 幂等保证
  }
  async close(): Promise<void> {
    await this.stop();
    this.owner = null;
    this.buffer.clear();
  }
}
```

这些方法只接受服务端已验证的 leaseId 对应连接；`safeTokenEqual` 直接复用阶段 A `terminal-hooks.ts` 的导出。普通聊天 WS 断开不调用 `detach`，只有 embedded owner 断开才启动 3 秒计时器。

`EmbeddedTerminalAdapter.start(context)` 复用阶段 A 的能力检测和 settings，核心启动代码为：

```ts
const transport = selectHookTransport(await probeCliVersion(context.cliPath));
const helperCommand = transport === "command" ? terminalHookCommand(context.leaseId) : undefined;
const args = [
  ...(context.initialSessionId ? ["--resume", context.initialSessionId] : ["--session-id", context.resumeSessionId]),
  "--settings", writeTerminalSettings(context, transport, helperCommand),
];
const env = transport === "command" ? {
  ...process.env,
  CCC_TERMINAL_HOOK_URL: `http://127.0.0.1:${context.port}/terminal-hook/${context.leaseId}`,
  CCC_TERMINAL_HOOK_TOKEN: context.hookToken,
} : process.env;
const pty = await this.backend.spawn({
  file: context.cliPath, args, cwd: context.folder, cols: 120, rows: 32, env,
});
```

`onData` 先 `buffer.append`，空字符串返回 null 时直接忽略，非空 chunk 只向 attached owner 发送；`onExit` 发 `terminal.exit`，随后走 lease `completeExit`。env 仅在后端内部传递，不进入 helper 日志、WS 或公开状态。

- [x] **Step 4: 接入 open/attach/close/服务器关闭并运行 GREEN**

`terminal.open embedded` 成功后生成 attachToken，仅向请求 WS 发送 `terminal.opened`；保留 `pendingOwner=ws` 直到同 WS 初次 attach。初次 attach 前其它连接不能使用 token。attach 回复顺序固定：`terminal.attached` → 重放的 `terminal.output`。`replayGap=true` 后立刻发 `OUTPUT_GAP` 并 `stop`，不发送伪造连续数据。

`ws.on("close")` 改为：

```ts
ws.on("close", () => {
  clients.delete(ws);
  terminalService.disconnect(ws); // 仅当 ws 是 embedded owner 才启动 3 秒计时器
});
```

`StartedServer.close()` 调用 `await terminalService.closeEmbedded()`，结束后端和所有重连计时器；系统 lease 保持阶段 A 行为。启动时内嵌记录不恢复连接：exit 文件/进程已退出则最终同步并清 lease；身份完全匹配则 kill 并同步；unknown 保持只读、允许人工确认解除，不 kill。

生产 `index.ts` 和 `tray.ts` 注入同一个按实测路线创建的 backend，开发态 `executableDir=path.resolve("dist/native-dev")`，编译态为 `path.dirname(process.execPath)`；不得开发态误把 `process.execPath` 当桥接目录。`--smoke` 保留，另加 `--pty-smoke <platform> <arch>`：仅在该显式 CLI 分支读取 `CCC_PTY_SMOKE_CLI` 指向的阶段 A 假 CLI，执行输入/持续输出/中文/resize/退出行为探针；普通 WS 和正常运行绝不接受该环境变量作为命令来源。

Run: `npm --prefix bridge test -- tests/embedded-terminal.test.ts tests/server-embedded-terminal.test.ts && npm --prefix bridge test && npm --prefix bridge run typecheck`
Expected: 初次/重连 attach、所有权、3 秒、缺口、退出恢复、native 失败隔离和完整桥接测试全部 PASS。

- [ ] **Step 5: 授权后的提交检查点**

```bash
git add bridge/src/embedded-terminal.ts bridge/src/terminal-service.ts bridge/src/server.ts bridge/src/index.ts bridge/src/tray.ts bridge/tests/embedded-terminal.test.ts bridge/tests/server-embedded-terminal.test.ts
git commit -m "实现插件终端生命周期与断线重连"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 5: 独立 terminal.html、xterm.js 和认证启动顺序

**Files:**
- Modify: `extension/package.json`, `extension/package-lock.json`
- Create: `extension/src/entrypoints/terminal/index.html`
- Create: `extension/src/entrypoints/terminal/main.tsx`
- Create: `extension/src/entrypoints/terminal/TerminalApp.tsx`
- Create: `extension/src/entrypoints/terminal/terminal.css`
- Create: `extension/src/lib/terminal-client.ts`
- Modify: `extension/src/entrypoints/background.ts`, `extension/src/lib/popup-registry.ts`
- Modify: `extension/src/components/AliasBar.tsx`, `extension/src/entrypoints/sidepanel/App.tsx`
- Test: `extension/tests/terminal-client.test.ts`
- Test: `extension/tests/terminal-window.test.tsx`
- Modify: `extension/tests/popup-registry.test.ts`

**Interfaces:**
- Consumes: 真实 `extension/src/lib/ws-client.ts` 的 `getHelloMessages()` 在 `auth.ok` 后执行机制。
- Produces: `openEmbeddedTerminal(aliasId?)` runtime 消息和 `TerminalClient`。
- 页面内存保存 `{leaseId,attachToken,lastSeq}`，不写 chrome.storage/sessionStorage/localStorage。

- [x] **Step 1: 安装前端依赖并写顺序/窗口失败测试**

```bash
npm --prefix extension install --save-exact @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 @xterm/addon-web-links@0.11.0
```

`terminal-client.test.ts` 复用 FakeWebSocket：

```ts
it("auth.ok 前不 open，opened 前不 attach，窗口创建失败不启动 Claude", async () => {
  const client = mountTerminalClient();
  expect(sentTypes()).not.toContain("terminal.open");
  fakeWs.emitOpen();
  expect(sentTypes()).not.toContain("terminal.open");
  fakeWs.emitMessage({ type: "auth.ok" });
  expect(sentTypes()).toContain("terminal.open");
  fakeWs.emitMessage({ type: "terminal.opened", leaseId: LEASE_ID, mode: "embedded", backend: "pty", attachToken: TOKEN });
  expect(sentMessages()).toContainEqual({ type: "terminal.attach", leaseId: LEASE_ID, attachToken: TOKEN, afterSeq: 0 });
});

it("输入带 leaseId，fit 行列发 resize，输出 seq 连续写入 xterm", async () => {
  const client = await attachedClient();
  client.input("中文\r");
  client.resize(132, 36);
  expect(sentMessages()).toContainEqual({ type: "terminal.input", leaseId: LEASE_ID, data: "中文\r" });
  expect(sentMessages()).toContainEqual({ type: "terminal.resize", leaseId: LEASE_ID, cols: 132, rows: 36 });
  client.serverOutput(1, "第一");
  client.serverOutput(2, "第二");
  expect(xtermWrites).toEqual(["第一", "第二"]);
  expect(client.lastSeq()).toBe(2);
});

it("重连 auth.ok 后 attach 同一 token/lastSeq，不重新 open", async () => {
  const client = await attachedClient();
  client.serverOutput(9, "保留");
  fakeWs.reconnect();
  fakeWs.emitOpen();
  expect(sentTypes()).not.toContain("terminal.open");
  fakeWs.emitMessage({ type: "auth.ok" });
  expect(sentMessages().at(-1)).toEqual({ type: "terminal.attach", leaseId: LEASE_ID, attachToken: TOKEN, afterSeq: 9 });
});

it("终端页接收旧 seq/缺口/错误并明确结束", async () => {
  const client = await attachedClient();
  client.serverOutput(2, "正确");
  client.serverOutput(2, "重复");
  expect(xtermWrites).toEqual(["正确"]);
  client.serverOutput(4, "缺失");
  expect(host.textContent).toContain("输出序号不连续，正在结束终端");
  expect(sentMessages().at(-1)).toEqual({ type: "terminal.close", leaseId: LEASE_ID });
});
```

`popup-registry.test.ts` 断言同 alias 终端窗口只创建一个、已有关闭后自愈、点击已存在窗口调用 `chrome.windows.update(windowId,{focused:true})`；窗口创建 reject 时聊天不发送任何 `terminal.open`。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix extension test -- tests/terminal-client.test.ts tests/terminal-window.test.tsx tests/popup-registry.test.ts`
Expected: FAIL，terminal 入口/client 不存在，background 没有 `terminal.open-window` 分支。

- [x] **Step 3: 实现 background 窗口和别名菜单**

AliasBar 将阶段 A 的 `>_` 按钮改为单菜单，完整命令为“在系统终端打开”“在插件终端打开”。未绑定文件夹时两个菜单项 disabled 且 title 为“请先绑定文件夹”；已有 embedded lease 时内嵌项只聚焦已有终端窗口，已有 system lease 时内嵌项提示“系统终端已接管”，两种情况都不创建第二个写入者。

background 新消息：

```ts
if (message?.type === "terminal.open-window") {
  const aliasId = typeof message.aliasId === "string" ? message.aliasId : undefined;
  const url = chrome.runtime.getURL(`terminal.html?alias=${aliasId ?? ""}`);
  await popupRegistry.openTerminal(url, aliasId); // 已有窗口聚焦，失败抛回可见错误
  return true;
}
```

`PopupRegistry` 使用独立 `terminalWindowByAlias` map 和 `terminal.html` URL 扫描，不复用聊天弹窗的网页钉住参数；聊天 popup 行为保持原样。App 点击内嵌命令只发 runtime 消息，background 返回失败时设置 `terminalError`，不调用 WS open。

- [x] **Step 4: 实现 TerminalClient 与 xterm 页面**

`getHelloMessages()` 必须返回动态闭包而不是窗口加载时的静态数组：

```ts
getHelloMessages: () => {
  const lease = leaseRef.current;
  if (lease) return [{ type: "terminal.attach", leaseId: lease.leaseId, attachToken: lease.attachToken, afterSeq: lease.lastSeq }];
  return openedRef.current ? [] : [{ type: "terminal.open", mode: "embedded" }];
}
```

初始 `openedRef` 防止同一认证重复 open；`terminal.opened` 后只在当前 open 的连接 attach。`terminal.attached replayGap=true` 或 seq 非 `lastSeq+1` 时显示错误并 close。重放消息按序写 xterm，重复 seq 忽略，旧 leaseId 忽略。WS disconnected 显示“连接中断，3 秒内尝试恢复”；超过 3 秒由服务端退出事件更新，不在客户端伪造 exit。

页面核心：

```tsx
const term = new Terminal({
  cursorBlink: true,
  fontFamily: "Cascadia Mono, Consolas, Menlo, monospace",
  fontSize: 14,
  scrollback: 5000,
  allowTransparency: false,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(hostRef.current!);
fit.fit();
term.onData((data) => clientRef.current?.input(data));
const resize = () => {
  fit.fit();
  if (clientRef.current?.isAttached()) clientRef.current.resize(term.cols, term.rows);
};
const observer = new ResizeObserver(resize);
observer.observe(hostRef.current!);
```

初次 `terminal.attached replayGap=false` 后立即调用一次 `client.resize(term.cols, term.rows)`，保证打开前的 fit 结果真正进入 PTY。React cleanup 顺序为 observer.disconnect、`term.dispose`、client.close；`pagehide` 只调用 `client.closePage()` 发一次 `terminal.close` 并关闭 WS，不把 token 写入存储。`terminal/main.tsx` 直接 `createRoot(...).render(<TerminalApp />)`，该有进程生命周期的独立入口不使用 StrictMode 双重 effect。按钮“结束终端”同样 close，禁用在 already stopping/idle。页头展示模式、服务端 folder/sessionId、degraded/exit/error，不显示 attachToken。xterm CSS 必须从 `@xterm/addon-fit` 包无冲突地引入 `@xterm/xterm/css/xterm.css`，终端容器有明确高度和 `min-width:0`。

- [x] **Step 5: 运行 GREEN 和完整构建**

Run: `npm --prefix extension test -- tests/terminal-client.test.ts tests/terminal-window.test.tsx tests/popup-registry.test.ts && npm --prefix extension test && npm --prefix extension run typecheck && npm --prefix extension run build`
Expected: 启动顺序、重连、序号、中文输入、fit resize、窗口去重和完整扩展测试 0 failures；build 输出包含 `terminal.html`，控制台无未处理异常。

- [x] **Step 6: 授权后的提交检查点（按用户要求跳过，不自动提交）**

```bash
git add extension/package.json extension/package-lock.json extension/src/entrypoints/terminal extension/src/lib/terminal-client.ts extension/src/entrypoints/background.ts extension/src/lib/popup-registry.ts extension/src/components/AliasBar.tsx extension/src/entrypoints/sidepanel/App.tsx extension/tests/terminal-client.test.ts extension/tests/terminal-window.test.tsx extension/tests/popup-registry.test.ts
git commit -m "新增独立插件终端窗口与真实输入输出"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 6: 原生发行布局、CI 和 macOS 签名

**Files:**
- Create: `bridge/scripts/package-pty.mjs`
- Create: `bridge/scripts/verify-native-layout.mjs`
- Create: `bridge/scripts/sign-mac-app.mjs`
- Modify: `bridge/scripts/build-exe.mjs`
- Modify: `bridge/scripts/build-mac-app.sh`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Test: `bridge/tests/native-layout.test.ts`

**Interfaces:**
- Produces: `dist/<target>/pty-manifest.json`，含实测 backend、Node runtime 版本（helper 时）、native 文件 SHA-256 列表。
- Produces: Windows zip 内完整目录和 macOS `.app` 内相同相对布局。

- [x] **Step 1: 写发行布局失败测试**

```ts
it("直接路线包含 node-pty JS 与全部本机文件，不能只存在 .node", async () => {
  await packagePty({ target: "win", backend: "bun-node-pty", outDir, nodeRuntime: null });
  const manifest = readManifest();
  expect(manifest.backend).toBe("bun-node-pty");
  expect(manifest.files.some((f) => f.path.endsWith("node-pty/package.json"))).toBe(true);
  expect(manifest.files.some((f) => f.path.endsWith(".node"))).toBe(true);
  expect(manifest.files.every((f) => f.sha256.length === 64)).toBe(true);
  await expect(verifyNativeLayout(outDir, "win32", "x64")).resolves.toBe(true);
});

it("helper 路线强制携带 Node 22、helper.cjs 和原生包", async () => {
  await packagePty({ target: "win", backend: "node-helper", outDir, nodeRuntime: fakeNode22Exe });
  expect(readManifest().nodeMajor).toBe(22);
  expect(exists("pty/helper.cjs")).toBe(true);
  expect(exists("runtime/node.exe")).toBe(true);
  fs.rmSync(nativeFile);
  await expect(verifyNativeLayout(outDir, "win32", "x64")).rejects.toThrow("NATIVE_LAYOUT");
});

it("macOS 先签内层 .node/helper/runtime，再签主程序和整包", async () => {
  const commands = await runMacPackaging({ dryRun: true, codesign: fakeCodesign });
  const nativeSign = commands.findIndex((c) => c.includes(".node") && c.startsWith("codesign"));
  const appSign = commands.findIndex((c) => c.includes("CopilotCC.app") && c.startsWith("codesign"));
  expect(nativeSign).toBeGreaterThanOrEqual(0);
  expect(appSign).toBeGreaterThan(nativeSign);
  expect(commands.at(-1)).toContain("codesign --verify --deep --strict");
});
```

测试创建独立临时输出目录；删除测试临时文件由测试框架清理，不触碰用户文件。

- [x] **Step 2: 运行 RED**

Run: `npm --prefix bridge test -- tests/native-layout.test.ts`
Expected: FAIL，package/verify 脚本不存在，build-mac-app 尚无内层签名步骤。实际首轮模块缺失 RED；后续探针路线门槛和 node-addon-api 漏包断言也分别先失败后修复。

- [x] **Step 3: 实现可复现布局**

`package-pty.mjs` 复制完整运行时依赖，不手工猜单个 DLL：

```js
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
copyRecursive(packageRoot, path.join(outDir, "pty", "node_modules", "node-pty"));
const files = walkFiles(path.join(outDir, "pty"))
  .map((file) => ({ path: slash(path.relative(outDir, file)), sha256: sha256File(file) }));
if (!files.some((file) => file.path.endsWith(".node"))) throw new Error("NATIVE_LAYOUT: missing addon");
if (backend === "node-helper") {
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("NODE_22_REQUIRED");
  copyFileSync(process.execPath, path.join(outDir, "runtime", windows ? "node.exe" : "node"));
  runOrFail(`bun build src/node-pty-helper.ts --target=node --format=cjs --outfile "${path.join(outDir, "pty", "helper.cjs")}"`);
}
writeFileSync(path.join(outDir, "pty-manifest.json"), JSON.stringify({ backend, files }, null, 2));
```

`BunPtyBackend` 和 helper 的 require 路径都固定为 `executableDir/pty/node_modules`，与 Tasks 1-2 一致。`verify-native-layout` 逐项重新计算 SHA-256，并检查 Windows `.node` 及 node-pty 包内随附 `.dll/.exe`、macOS `.node` 都被 manifest 覆盖。

- [x] **Step 4: 把行为探针设为 CI/Release 硬门槛并运行 GREEN**

`build-exe.mjs` 编译主 exe 后调用 package 和 verify；不得再宣称 Windows 是单 exe 目录。CI Windows 步骤执行：

```bash
node scripts/run-pty-probe.mjs --route auto --target win --root "$RUNNER_TEMP/ccc-pty-win"
CCC_PTY_SMOKE_CLI="$RUNNER_TEMP/ccc-pty-win/fake-claude.exe" ./dist/ccc-bridge-win-x64/ccc-bridge.exe --pty-smoke win32 x64
```

探针必须从复制到 `$RUNNER_TEMP` 的完整发行目录启动，CWD 不在仓库，删除/隐藏仓库模块解析路径。任一原生文件缺失、路线探针失败或 `--pty-smoke` 失败，构建非零退出。

macOS `build-mac-app.sh` 将 `pty/`、`runtime/`（若选择 helper）复制到 `Contents/MacOS`，逐个对 `.node`、helper runtime、主程序和托盘 helper ad-hoc 签名，再签 `.app` 并执行：

```bash
codesign --verify --deep --strict --verbose=2 "$APP"
node scripts/run-pty-probe.mjs --route auto --target darwin --root "$RUNNER_TEMP/ccc-pty-mac"
```

Release 上传完整目录 zip/DMG，不再只压缩 exe。Windows 本机验收前不得把 CI 交叉编译当作运行证据；macOS 签名和行为探针必须在 macOS arm64 runner 真实执行并上传不含秘密的 `pty-route.json` artifact。

Run: `npm --prefix bridge test -- tests/native-layout.test.ts && npm --prefix bridge test && npm --prefix bridge run typecheck && node bridge/scripts/run-pty-probe.mjs --route auto --target win --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\task6-release-run-1" && node bridge/scripts/build-exe.mjs win --pty-route "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\task6-release-run-1\pty-route.json" && node bridge/scripts/verify-native-layout.mjs "D:\SVN_Cursor\chromeClaudeCode\bridge\dist\ccc-bridge-win-x64" win32 x64`
Expected: 布局测试、完整测试和类型检查 PASS；Windows 构建/布局校验 exit 0，manifest 文件和 hash 完整。实际 bridge 35 文件 394/394、typecheck exit 0，真实路线与完整目录构建通过；项目树外 smoke 六项全 true，缺 conpty.node 负控 verify/smoke 均 exit 1，remaining=0。未实际运行 macOS 命令，macOS 不标记 GREEN。

- [x] **Step 5: 授权后的提交检查点（按用户要求跳过，不自动提交）**

```bash
git add bridge/scripts/package-pty.mjs bridge/scripts/verify-native-layout.mjs bridge/scripts/build-exe.mjs bridge/scripts/build-mac-app.sh bridge/src/bun-pty-backend.ts bridge/src/node-pty-backend.ts .github/workflows/ci.yml .github/workflows/release.yml bridge/tests/native-layout.test.ts
git commit -m "打包并强制验收原生终端运行时"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

---

### Task 7: 双终端真实 Windows 验收与最终文档

**Files:**
- Create: `bridge/scripts/verify-embedded-terminal.mjs`
- Modify: `README.md`, `docs/guide.md`, `docs/development.md`, `TODO.md`（执行前逐项取得用户确认）
- Evidence: `D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\embedded-verification.json`

- [ ] **Step 1: 写完整验收断言并先证明会失败**

验收脚本使用阶段 A 假 CLI，不调用真实 API；强制校验：

```js
const assertions = {
  terminalWindowVisible: true,
  terminalWindowDeduped: true,
  authenticatedBeforeOpen: true,
  attachedAfterOpenedOnSameConnection: true,
  resumedCorrectSession: true,
  inputAndContinuousOutput: true,
  chineseInputOutput: true,
  imeCompositionNotDuplicated: true,
  resizedPtyTo132x36: true,
  sidepanelAndChatPopupReadonly: true,
  jsonlMirrorNotAnsiParsed: true,
  clearResumeForkFollowedHooks: true,
  compactAndTaskCollapsedExpandable: true,
  ordinaryExternalSessionListedWithoutTakeover: true,
  directWritesRejected: true,
  replayContiguous: true,
  reconnectWithin3Seconds: true,
  reconnectAfter3SecondsKillsOwnedPty: true,
  refreshCannotReuseAttachToken: true,
  outputGapVisibleAndCloses: true,
  closeButtonRestoresLastHookSession: true,
  bridgeShutdownKillsOwnedPty: true,
  abnormalRestartNeverKillsUnknownIdentity: true,
  nativeFailureLeavesChatAndSystemTerminalUsable: true,
  compiledExeOutsideProjectTree: true,
  realApiCalled: false,
};
for (const [name, expected] of Object.entries(assertions)) {
  if (evidence[name] !== expected) throw new Error(`验收失败: ${name}`);
}
if (evidence.runtimeErrors.length) throw new Error("Chrome 存在运行错误");
if (evidence.macOSVerified !== false) throw new Error("无 macOS 证据时必须保持未验收");
```

Run: 对同一完整隔离构建运行 `node bridge/scripts/verify-embedded-terminal.mjs --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\embedded-red" --negative-control attach`。该参数只让验收用的本机 WS 代理丢弃首次 attach，不修改生产代码。
Expected: 非零退出，记录准确的 attach/输入输出证据缺失；连接失败和脚本异常不得记成功。随后不携带负控参数重新运行同一构建。

- [ ] **Step 2: 构建并在项目树外运行真实 Chrome 验收**

Run:

```bash
npm --prefix bridge test
npm --prefix bridge run typecheck
npm --prefix extension test
npm --prefix extension run typecheck
npm --prefix extension run build
node bridge/scripts/run-pty-probe.mjs --route auto --target win --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\final-native"
node bridge/scripts/build-exe.mjs win --pty-route "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\final-native\pty-route.json"
node bridge/scripts/verify-native-layout.mjs "D:\SVN_Cursor\chromeClaudeCode\bridge\dist\ccc-bridge-win-x64" win32 x64
node bridge/scripts/verify-embedded-terminal.mjs --root "D:\ccc-fast-final-verify-20261026\tool-history-20261027\dual-terminal-20261110\embedded-run-1"
```

脚本必须从别名行真实菜单打开独立 Chrome 窗口，用 xterm 的键盘事件和输入法 composition 事件输入中文，读取真实 PTY 子进程输出；resize 后由子进程报告 132×36。关闭侧边栏/聊天弹窗不得杀 PTY；断开终端 WS 2 秒重连应补齐 seq，超过 3 秒应退出；刷新页面不得复用 token。直接 WS 构造其它连接的 input/resize/close 必须 `NOT_OWNER`。

记录实际选择的 PTY 路线、原生 manifest hash、窗口截图、seq/resize/退出证据和 `runtimeErrors=[]`。证据文件不得包含 hook/attach/pairing token、完整环境、API key 或私有配置。

Expected: 两端完整测试 0 failures，构建和探针 exit 0，真实 Chrome 验收 exit 0，`realApiCalled=false`，用户正在运行的桥接未被停止或替换。

- [ ] **Step 3: 更新文档与范围状态**

README 增加一个 `>_` 菜单和两种终端的简短说明；guide 写只读、会话跟随、重连/关闭和转录保留；development 写直接/helper 路线选择、目录布局、探针和隔离验收；TODO 记录 Windows 证据路径和 macOS 未验收状态。不得把真实终端能力写成依赖 Remote Control 或官方登录。

Run: `git diff --check && git status --short`
Expected: 无空白错误；根目录 zip/JPG 保持未跟踪；证据目录不进入仓库。

- [ ] **Step 4: 授权后的最终提交检查点**

```bash
git add bridge/scripts/verify-embedded-terminal.mjs README.md docs/guide.md docs/development.md TODO.md docs/superpowers/plans/2026-11-10-embedded-terminal.md docs/superpowers/specs/2026-11-10-dual-terminal-design.md
git commit -m "完成插件终端与双模式同步验收"
git show -s --format='%an <%ae>%n%cn <%ce>%n%B' HEAD
```

Expected: 只有用户本人作者/提交者，无共同作者；不得自动 push、tag 或 Release。

## Final Exit Checklist

- [ ] 系统终端和插件终端均可从同一 `>_` 菜单使用，当前会话续聊正确。
- [ ] 普通外部终端新会话自动进入列表，两种接管都由有效 Hook 跟随 `/clear`、`/resume`、fork 和 compact。
- [ ] xterm.js 背后为真实 PTY，输入、持续输出、中文/IME、resize 和退出均有编译产物证据。
- [ ] 原始 ANSI 与结构化聊天镜像分离，旧分页/折叠/稳定 ID 行为不回归。
- [ ] seq、重放缺口、连接所有权、3 秒重连、刷新/关闭和桥接退出清理均通过测试和真实 Windows 验收。
- [ ] 发行包包含所选后端全部原生文件，helper 路线包含 Node 22，CI/Release 失败不会静默出包。
- [ ] 未调用真实 API，未影响用户桥接，未自动提交/推送/发布。
- [ ] macOS 没有真实 arm64 PTY、Terminal.app 和签名证据时仍明确标为未验收。
