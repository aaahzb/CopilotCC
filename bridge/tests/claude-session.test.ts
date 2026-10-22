import { describe, it, expect, vi } from "vitest";
import { createClaudeSession, type SessionEvents } from "../src/claude-session";

/** 收集事件的 events 桩 */
function stubEvents(): SessionEvents & { log: Array<[string, ...unknown[]]> } {
  const log: Array<[string, ...unknown[]]> = [];
  return {
    log,
    onDelta: (t) => log.push(["delta", t]),
    onTool: (n, s) => log.push(["tool", `${n}:${s}`]),
    onDone: (s, info) => log.push(["done", s, info]),
    onError: (m) => log.push(["error", m]),
    onPermission: (r) => log.push(["permission", r]),
    onSessionId: (id) => log.push(["sid", id]),
    onAborted: () => log.push(["aborted"]),
  };
}

/** 假 SDK query：记录入参，按脚本产出消息 */
function fakeQuery(script: unknown[]) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = (args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
  return { fn, calls };
}

const INIT = { type: "system", subtype: "init", session_id: "sid-1" };
const DELTA = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } };
const TOOL = { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "a.md" } }] } };
const DONE = { type: "result", subtype: "success" };

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
