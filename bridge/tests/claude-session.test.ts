import { describe, it, expect, vi } from "vitest";
import { createClaudeSession, parseEnvDump, parseShellProbeOutput, wellKnownClaudePaths, type SessionEvents, type SessionRuntimeInfo } from "../src/claude-session";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** 收集事件的 events 桩 */
function stubEvents(): SessionEvents & { log: Array<[string, ...unknown[]]>; runtime: SessionRuntimeInfo[] } {
  const log: Array<[string, ...unknown[]]> = [];
  const runtime: SessionRuntimeInfo[] = [];
  return {
    log,
    runtime,
    onRuntime: (info) => runtime.push(info),
    onDelta: (t) => log.push(["delta", t]),
    onTool: (n, s) => log.push(["tool", `${n}:${s}`]),
    onCompact: (ev) => log.push(["compact", ev]),
    onDone: (s, info) => log.push(["done", s, info]),
    onError: (m) => log.push(["error", m]),
    onPermission: (r) => log.push(["permission", r]),
    onAsk: (r) => log.push(["ask", r]),
    onSessionId: (id) => log.push(["sid", id]),
    onAborted: () => log.push(["aborted"]),
  };
}

/** 假 SDK query：记录入参，按脚本产出消息 */
function fakeQuery(
  script: unknown[],
  applyFlagSettings?: (settings: { fastMode: boolean; model?: string }) => Promise<void>,
  getSettings?: () => Promise<unknown>,
) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    const gen = (async function* () {
      for (const m of script) yield m;
    })();
    return Object.assign(gen, {
      ...(applyFlagSettings ? { applyFlagSettings } : {}),
      ...(getSettings ? { getSettings } : {}),
    });
  };
  return { fn, calls };
}

const INIT = { type: "system", subtype: "init", session_id: "sid-1" };
const DELTA = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } };
const TOOL = { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "a.md" } }] } };
const DONE = { type: "result", subtype: "success" };

describe("AskUserQuestion 提问", () => {
  const ASK_INPUT = {
    questions: [{
      question: "选哪个？", header: "方案",
      options: [{ label: "A", description: "用 A" }, { label: "B" }],
      multiSelect: false,
    }],
  };

  async function setup(permissionMode: "auto" | "approve-each" = "auto") {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode, events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    const canUseTool = calls[0].options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }>;
    return { s, ev, canUseTool };
  }

  it("auto 模式也转发提问，答案回填 updatedInput.answers 且原参数保留", async () => {
    const { s, ev, canUseTool } = await setup("auto");
    const p = canUseTool("AskUserQuestion", ASK_INPUT);
    await new Promise((r) => setTimeout(r, 20));
    const askLog = ev.log.find(([k]) => k === "ask") as [string, { requestId: string; questions: unknown[] }];
    expect(askLog).toBeTruthy();
    expect(askLog[1].questions).toEqual(ASK_INPUT.questions);
    s.respondAsk(askLog[1].requestId, { "选哪个？": "A" });
    const res = await p;
    expect(res.behavior).toBe("allow");
    expect(res.updatedInput?.answers).toEqual({ "选哪个？": "A" });
    expect(res.updatedInput?.questions).toEqual(ASK_INPUT.questions);
    await s.close();
  });

  it("用户未作答（null）按拒绝释放", async () => {
    const { s, ev, canUseTool } = await setup();
    const p = canUseTool("AskUserQuestion", ASK_INPUT);
    await new Promise((r) => setTimeout(r, 20));
    const askLog = ev.log.find(([k]) => k === "ask") as [string, { requestId: string }];
    s.respondAsk(askLog[1].requestId, null);
    expect((await p).behavior).toBe("deny");
    await s.close();
  });

  it("questions 结构非法不特判（auto 走防御性拒绝）", async () => {
    const { s, ev, canUseTool } = await setup();
    const res = await canUseTool("AskUserQuestion", { questions: [{ nope: true }] });
    expect(res.behavior).toBe("deny");
    expect(ev.log.find(([k]) => k === "ask")).toBeUndefined();
    await s.close();
  });

  it("close() 释放挂起提问", async () => {
    const { s, canUseTool } = await setup();
    const p = canUseTool("AskUserQuestion", ASK_INPUT);
    await new Promise((r) => setTimeout(r, 20));
    await s.close();
    expect((await p).behavior).toBe("deny");
  });
});

describe("createClaudeSession", () => {
  it("init/delta/tool/result 事件正确转发", async () => {
    const { fn } = fakeQuery([INIT, DELTA, TOOL, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(ev.log).toEqual([
      ["sid", "sid-1"],
      ["delta", "你好"],
      ["tool", "Write:a.md"],
      ["done", "sid-1", { model: undefined, effort: undefined }], // INIT 未带 model/effort 字段（老 CLI 形态）
    ]);
    await s.close();
  });

  it("AskUserQuestion 不发送普通工具活动，其他工具保持原样", async () => {
    const ASK_TOOL = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [] } }] },
    };
    const { fn } = fakeQuery([INIT, ASK_TOOL, TOOL, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(ev.log.filter(([kind]) => kind === "tool")).toEqual([["tool", "Write:a.md"]]);
    await s.close();
  });

  it("resumeId 与权限模式透传给 SDK options", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { resumeId: "old-9", permissionMode: "acceptEdits", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls[0].options.resume).toBe("old-9");
    expect(calls[0].options.permissionMode).toBe("acceptEdits");
    expect(calls[0].options.cwd).toBe("D:\\notes");
    await s.close();
  });

  it("approve-each 模式映射为 SDK default + canUseTool 回调", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "approve-each", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls[0].options.permissionMode).toBe("default");
    expect(typeof calls[0].options.canUseTool).toBe("function");
    await s.close();
  });

  it("canUseTool 触发 onPermission，respondPermission(allow) 放行", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "approve-each", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    const canUseTool = calls[0].options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
    const p = canUseTool("Bash", { command: "ls" });
    await new Promise((r) => setTimeout(r, 20));
    const permLog = ev.log.find(([k]) => k === "permission");
    expect(permLog).toBeTruthy();
    const req = (permLog as [string, { requestId: string }])[1];
    s.respondPermission(req.requestId, true);
    expect((await p).behavior).toBe("allow");
    await s.close();
  });

  it("新会话首轮用户消息带防注入前缀", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    s.send("你好");
    await new Promise((r) => setTimeout(r, 50));
    const stream = calls[0].prompt as AsyncIterable<{ message: { content: string }; session_id: string }>;
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.message.content).toContain("防注入");
    expect(first.value.message.content).toContain("你好");
    await s.close();
  });

  it("首条消息不等 init：真实 CLI 收到首条输入才发 init（等则死锁）", async () => {
    // 假 SDK 复刻真实 CLI 时序（probe2 实证）：先从 prompt 拉到一条用户消息，才回 init
    let firstSessionId: string | undefined;
    const fn = (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      (async function* () {
        const it = args.prompt[Symbol.asyncIterator]();
        const first = await it.next(); // bridge 若等 init 再发，这里永久挂起 → 测试超时失败
        firstSessionId = (first.value as { session_id?: string }).session_id;
        yield { type: "system", subtype: "init", session_id: "sid-real" };
        yield { type: "result", subtype: "success", session_id: "sid-real" };
      })();
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    s.send("你好");
    await vi.waitFor(() => expect(ev.log.map(([k]) => k)).toContain("done"), { timeout: 2000 });
    expect(firstSessionId).toBe(""); // 新会话首条用空 session_id，init 到达后由 CLI 分配
    expect(ev.log).toContainEqual(["sid", "sid-real"]);
    await s.close();
  });

  it("init 上报的实际模型/effort 随 onDone 传出，runtimeInfo 可查", async () => {
    const INIT_RT = { type: "system", subtype: "init", session_id: "sid-2", model: "claude-fable-5-1", effort: "high" };
    const { fn } = fakeQuery([INIT_RT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(ev.log).toContainEqual(["done", "sid-2", { model: "claude-fable-5-1", effort: "high" }]);
    expect(s.runtimeInfo()).toEqual({ model: "claude-fable-5-1", effort: "high" });
    await s.close();
  });

  it("effort 为 null（该会话不下发 effort 参数）时原样传出", async () => {
    const INIT_NULL = { type: "system", subtype: "init", session_id: "sid-3", model: "claude-opus-4-5", effort: null };
    const { fn } = fakeQuery([INIT_NULL, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(ev.log).toContainEqual(["done", "sid-3", { model: "claude-opus-4-5", effort: null }]);
    await s.close();
  });

  it("compact_boundary 帧置位后 onDone 携带 compacted:true（未发生则不下发该字段）", async () => {
    const COMPACT = { type: "system", subtype: "compact_boundary", compact_metadata: {} };
    const { fn } = fakeQuery([INIT, COMPACT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(ev.log).toContainEqual(["done", "sid-1", { model: undefined, effort: undefined, compacted: true }]);
    await s.close();
  });

  describe("原生 fast 设置与真值", () => {
    it("启动时 true/false 都显式进入 SDK settings，不发明顶层参数", async () => {
      for (const enabled of [true, false]) {
        const { fn, calls } = fakeQuery([INIT, DONE]);
        const ev = stubEvents();
        const s = createClaudeSession("D:\notes", { permissionMode: "auto", fastMode: enabled, events: ev, queryFn: fn });
        await new Promise((r) => setTimeout(r, 20));
        expect(calls[0]!.options.settings).toEqual({ fastMode: enabled });
        expect(calls[0]!.options.fastMode).toBeUndefined();
        await s.close();
      }
    });

    it("setFastMode 只调用原生 applyFlagSettings，并保持快速连切顺序", async () => {
      let releaseFirst!: () => void;
      const apply = vi.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
        .mockResolvedValueOnce(undefined);
      const { fn } = fakeQuery([], apply);
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      const first = s.setFastMode(true);
      const second = s.setFastMode(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenLastCalledWith({ fastMode: true });
      releaseFirst();
      await first;
      await second;
      expect(apply.mock.calls).toEqual([[{ fastMode: true }], [{ fastMode: false }]]);
      await s.close();
    });

    it("原生设置拒绝会传播，且后续切换仍可执行", async () => {
      const apply = vi.fn().mockRejectedValueOnce(new Error("native denied")).mockResolvedValueOnce(undefined);
      const { fn } = fakeQuery([], apply);
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await expect(s.setFastMode(true)).rejects.toThrow("native denied");
      await s.setFastMode(false);
      expect(apply).toHaveBeenCalledTimes(2);
      await s.close();
    });

    it("单次组合控制携带 Opus 或恢复模型，undefined 省略 model 键", async () => {
      const apply = vi.fn(() => Promise.resolve());
      const { fn } = fakeQuery([], apply);
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await s.setFastMode(true, "opus");
      await s.setFastMode(false, "claude-sonnet-5-5");
      await s.setFastMode(false, undefined);
      expect(apply.mock.calls).toEqual([
        [{ fastMode: true, model: "opus" }],
        [{ fastMode: false, model: "claude-sonnet-5-5" }],
        [{ fastMode: false }],
      ]);
      await s.close();
    });

    it("自动档从 CC applied.model 捕获恢复目标，快速 on/off 仍严格串行", async () => {
      let releaseSettings!: () => void;
      const getSettings = vi.fn(() => new Promise((resolve) => {
        releaseSettings = () => resolve({
          effective: { model: "fable" },
          applied: { model: "claude-fable-5-1" },
        });
      }));
      const apply = vi.fn(() => Promise.resolve());
      const { fn } = fakeQuery([], apply, getSettings);
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", events: ev, queryFn: fn });
      const on = s.setFastMode(true, "opus");
      const off = s.setFastMode(false, null);
      await new Promise((r) => setTimeout(r, 20));
      expect(apply).not.toHaveBeenCalled(); // 后续 off 不得越过首个 on 的异步模型捕获
      releaseSettings();
      await on;
      await off;
      expect(getSettings).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls).toEqual([
        [{ fastMode: true, model: "opus" }],
        [{ fastMode: false, model: "claude-fable-5-1" }],
      ]);
      await expect(s.fastAutoModel()).resolves.toBe("claude-fable-5-1");
      await s.close();
    });

    it("启动即 fast-on 的自动档在首轮前缓存 applied.model，off 不读取提升后的 Opus", async () => {
      const getSettings = vi.fn()
        .mockResolvedValueOnce({ applied: { model: "claude-fable-5-1" } })
        .mockResolvedValueOnce({ applied: { model: "claude-opus-5-5" } });
      const apply = vi.fn(() => Promise.resolve());
      const { fn } = fakeQuery([], apply, getSettings);
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", fastMode: true, events: ev, queryFn: fn });
      await new Promise((r) => setTimeout(r, 20));
      expect(getSettings).toHaveBeenCalledTimes(1);
      await s.setFastMode(false, null);
      expect(apply).toHaveBeenCalledWith({ fastMode: false, model: "claude-fable-5-1" });
      expect(getSettings).toHaveBeenCalledTimes(1);
      await s.close();
    });

    it("CC 元数据不可用时回退到开启前 init 的实际模型", async () => {
      const getSettings = vi.fn(() => Promise.reject(new Error("old CLI")));
      const apply = vi.fn(() => Promise.resolve());
      const init = { ...INIT, model: "claude-fable-5-1" };
      const { fn } = fakeQuery([init], apply, getSettings);
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await new Promise((r) => setTimeout(r, 20));
      await s.setFastMode(true, "opus");
      await s.setFastMode(false, null);
      expect(apply.mock.calls).toEqual([
        [{ fastMode: true, model: "opus" }],
        [{ fastMode: false, model: "claude-fable-5-1" }],
      ]);
      await s.close();
    });

    it("旧 CLI 无元数据且首轮前无 init 时仍关 fast，但不伪造恢复模型", async () => {
      const apply = vi.fn(() => Promise.resolve());
      const { fn } = fakeQuery([], apply); // 没有 getSettings 方法
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await s.setFastMode(true, "opus");
      await s.setFastMode(false, null);
      expect(apply.mock.calls).toEqual([
        [{ fastMode: true, model: "opus" }],
        [{ fastMode: false }],
      ]);
      await expect(s.fastAutoModel()).resolves.toBeUndefined();
      await s.close();
    });

    it("result 覆盖 init 的 fast 状态，新状态无原因时清除旧原因", async () => {
      const init = { ...INIT, model: "claude-opus-5-5", fast_mode_state: "off", fast_mode_disabled_reason: "model_not_allowed" };
      const done = { ...DONE, fast_mode_state: "on" };
      const { fn } = fakeQuery([init, done]);
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await new Promise((r) => setTimeout(r, 30));
      expect(ev.runtime[0]).toMatchObject({ model: "claude-opus-5-5", fast: { state: "off", disabledReason: "model_not_allowed" } });
      expect(s.runtimeInfo().fast).toEqual({ state: "on" });
      expect(ev.log).toContainEqual(["done", "sid-1", { model: "claude-opus-5-5", effort: undefined, fast: { state: "on" }, fastFresh: true }]);
      await s.close();
    });

    it("后续帧缺少 fast 字段保留最近真值，cooldown 原样上报", async () => {
      const init = { ...INIT, fast_mode_state: "cooldown", fast_mode_disabled_reason: "network_error" };
      const { fn } = fakeQuery([init, DONE]);
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await new Promise((r) => setTimeout(r, 30));
      expect(s.runtimeInfo().fast).toEqual({ state: "cooldown", disabledReason: "network_error" });
      await s.close();
    });
    it("fast 缓存回放带非新鲜标记，onDone 同样保留该标记", async () => {
      const init = { ...INIT, model: "claude-opus-5-5", fast_mode_state: "off" };
      const { fn } = fakeQuery([init, DONE]);
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await new Promise((r) => setTimeout(r, 30));
      expect(ev.runtime).toHaveLength(2);
      expect(ev.runtime[0]).toMatchObject({ fast: { state: "off" }, fastFresh: true });
      expect(ev.runtime[1]).toMatchObject({ fast: { state: "off" }, fastFresh: false });
      const done = ev.log.find((entry) => entry[0] === "done");
      expect(done?.[2]).toMatchObject({ fast: { state: "off" }, fastFresh: false });
      expect(s.runtimeInfo().fast).toEqual({ state: "off" });
      expect(s.runtimeInfo().fastFresh).toBeUndefined();
      await s.close();
    });

    it("同值 fast 新回报仍标为新鲜，不能靠值变化推断", async () => {
      const init = { ...INIT, fast_mode_state: "off" };
      const done = { ...DONE, fast_mode_state: "off" };
      const { fn } = fakeQuery([init, done]);
      const ev = stubEvents();
      const s = createClaudeSession("D:/notes", { permissionMode: "auto", events: ev, queryFn: fn });
      await new Promise((r) => setTimeout(r, 30));
      expect(ev.runtime[0]).toMatchObject({ fastFresh: true });
      expect(ev.runtime[1]).toMatchObject({ fastFresh: true });
      const doneEvent = ev.log.find((entry) => entry[0] === "done");
      expect(doneEvent?.[2]).toMatchObject({ fastFresh: true });
      await s.close();
    });

  });

  describe("abort 手动中止", () => {
    /** 可控假 SDK query：帧由测试手动推入；interrupt 是间谍（可注入拒绝实现） */
    function manualQuery(interruptImpl?: () => Promise<void>): {
      fn: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<unknown>;
      interrupt: ReturnType<typeof vi.fn>;
      push: (m: unknown) => void;
    } {
      const queue: unknown[] = [];
      let notify: (() => void) | null = null;
      const interrupt = vi.fn(interruptImpl ?? (() => Promise.resolve()));
      const fn = () => {
        const gen = (async function* () {
          for (;;) {
            while (queue.length > 0) yield queue.shift();
            await new Promise<void>((r) => (notify = r));
            notify = null;
          }
        })();
        return Object.assign(gen, { interrupt });
      };
      const push = (m: unknown): void => {
        queue.push(m);
        notify?.();
      };
      return { fn, interrupt, push };
    }

    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

    it("中止进行中的轮次：立即 onAborted、调 SDK interrupt、该轮收尾 result 帧被吞", async () => {
      const { fn, interrupt, push } = manualQuery();
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      push(INIT);
      await tick();
      s.send("长任务");
      s.abort(); // 思考/工具调用期（尚无首字）即可中止
      expect(ev.log).toContainEqual(["aborted"]);
      expect(interrupt).toHaveBeenCalledTimes(1);
      push(DONE); // 被中止轮的收尾帧：成败都不再发 done/error（客户端已被 aborted 释放）
      await tick();
      expect(ev.log.map(([k]) => k)).not.toContain("done");
      expect(ev.log.map(([k]) => k)).not.toContain("error");
      await s.close();
    });

    it("close 进行中的会话也会 interrupt 并关闭 SDK 流：重建后旧工具不能继续跑", async () => {
      const interrupt = vi.fn(() => Promise.resolve());
      const returnStream = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }));
      const stream = Object.assign(
        (async function* () {
          await new Promise<void>(() => {}); // 永不自然结束，模拟正在执行工具的真实 SDK 流
        })(),
        { interrupt, return: returnStream },
      );
      const ev = stubEvents();
      const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: () => stream });
      s.send("长任务");
      await s.close();
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(returnStream).toHaveBeenCalledTimes(1);
      expect(ev.log.map(([k]) => k)).not.toContain("aborted"); // close 是静默生命周期收尾，由 server 决定界面通知
    });

    it("空闲时 abort 是空操作：不触发 onAborted、不调 interrupt（竞态：done 在途时点了停止）", async () => {
      const { fn, interrupt, push } = manualQuery();
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      push(INIT);
      await tick();
      s.abort();
      expect(interrupt).not.toHaveBeenCalled();
      expect(ev.log.map(([k]) => k)).not.toContain("aborted");
      await s.close();
    });

    it("interrupt 拒绝（CLI 侧轮次已结束）不冒泡、不影响已下发的 onAborted", async () => {
      const { fn, interrupt } = manualQuery(() => Promise.reject(new Error("no active turn")));
      const ev = stubEvents();
      const s = createClaudeSession("D:\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      s.send("x");
      s.abort();
      expect(ev.log).toContainEqual(["aborted"]);
      expect(interrupt).toHaveBeenCalledTimes(1);
      await tick(); // 给拒绝一个冒泡窗口：未捕获的 rejection 会被 vitest 标红
      await s.close();
    });
  });
});

describe("CLI 路径解析兜底（macOS GUI 应用 PATH 隔离对策）", () => {
  it("wellKnownClaudePaths：官方安装器位置优先，含 Homebrew 两前缀", () => {
    const list = wellKnownClaudePaths("/home/u");
    expect(list[0]).toBe(path.join("/home/u", ".claude", "local", "claude"));
    expect(list).toContain("/opt/homebrew/bin/claude");
    expect(list).toContain("/usr/local/bin/claude");
  });

  it("parseShellProbeOutput：干净输出直取", () => {
    expect(parseShellProbeOutput("/Users/x/.claude/local/claude\n")).toBe("/Users/x/.claude/local/claude");
  });

  it("parseShellProbeOutput：rc 噪声在前时取倒数第一个合格行", () => {
    const noisy = "(base) \x1b[0m\n欢迎使用\n/Users/x/.nvm/versions/node/v22.0.0/bin/claude\n";
    expect(parseShellProbeOutput(noisy)).toBe("/Users/x/.nvm/versions/node/v22.0.0/bin/claude");
  });

  it("parseShellProbeOutput：空输出/无合格行/非 claude 结尾一律 null", () => {
    expect(parseShellProbeOutput("")).toBeNull();
    expect(parseShellProbeOutput("command not found\n")).toBeNull();
    expect(parseShellProbeOutput("/usr/bin/claude-old\n")).toBeNull(); // basename 必须是 claude
  });
});

describe("parseEnvDump（macOS GUI 环境变量兜底）", () => {
  it("只挑 ANTHROPIC_/CLAUDE_/代理变量，PATH/HOME 等一律丢弃", () => {
    const dump = "PATH=/usr/bin\nANTHROPIC_AUTH_TOKEN=sk-ant-x\nANTHROPIC_BASE_URL=https://relay.example.com\nHOME=/Users/x\nhttps_proxy=http://127.0.0.1:7890\n";
    expect(parseEnvDump(dump)).toEqual({
      ANTHROPIC_AUTH_TOKEN: "sk-ant-x",
      ANTHROPIC_BASE_URL: "https://relay.example.com",
      https_proxy: "http://127.0.0.1:7890",
    });
  });

  it("值含 = 不切错（base64 token）；无 = 的 rc 噪声行跳过", () => {
    const dump = "欢迎语一行\nANTHROPIC_AUTH_TOKEN=dGVzdA==\n(base) \nCLAUDE_CODE_FOO=1\n";
    expect(parseEnvDump(dump)).toEqual({ ANTHROPIC_AUTH_TOKEN: "dGVzdA==", CLAUDE_CODE_FOO: "1" });
  });

  it("空输出 → 空表", () => {
    expect(parseEnvDump("")).toEqual({});
  });
});

describe("压缩进度事件", () => {
  function compactSession(script: unknown[]) {
    const q = fakeQuery(script);
    const compact: unknown[] = [];
    const s = createClaudeSession(".", {
      permissionMode: "auto",
      queryFn: q.fn,
      events: {
        onDelta() {}, onTool() {}, onDone() {}, onRuntime() {}, onError() {}, onAborted() {},
        onPermission() {}, onSessionId() {}, onAsk() {},
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
