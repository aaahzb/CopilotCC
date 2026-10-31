import { describe, it, expect, vi } from "vitest";
import { createClaudeSession, GUARD_PREFIX, parseEnvDump, parseShellProbeOutput, wellKnownClaudePaths, type SessionEvents, type SessionRuntimeInfo } from "../src/claude-session";
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
    onTool: (n, s, toolUseId, input) => log.push(["tool", `${n}:${s}`, ...(toolUseId ? [{ toolUseId, input }] : [])]),
    onToolResult: (r) => log.push(["toolResult", r]),
    onCompact: (ev) => log.push(["compact", ev]),
    onDone: (s, info) => log.push(["done", s, info]),
    onError: (m) => log.push(["error", m]),
    onPermission: (r) => log.push(["permission", r]),
    onAsk: (r) => log.push(["ask", r]),
    onSessionId: (id) => log.push(["sid", id]),
    onAborted: () => log.push(["aborted"]),
    onInteractionSettled: (r) => log.push(["interactionSettled", r]),
    onNotice: (notice) => log.push(["notice", notice]),
    onRequesting: (requesting) => log.push(["requesting", requesting]),
    onElicitation: (request) => log.push(["elicitation", request]),
    onElicitationComplete: (request) => log.push(["elicitationComplete", request]),
    onUserDialog: (request) => log.push(["userDialog", request]),
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

  it("保留真实 CLI 提供的选项 preview，不把技术详情误当 annotations", async () => {
    const { s, ev, canUseTool } = await setup();
    const richInput = {
      questions: [{
        ...ASK_INPUT.questions[0]!,
        options: [{ label: "A", description: "用 A", preview: "A 的预览\n第二行" }],
      }],
    };
    const pending = canUseTool("AskUserQuestion", richInput);
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "ask")).toBe(true));
    const req = (ev.log.find(([kind]) => kind === "ask") as [string, { requestId: string; questions: Array<{ options: Array<{ preview?: string }> }> }])[1];
    expect(req.questions[0]!.options[0]!.preview).toBe("A 的预览\n第二行");
    s.respondAsk(req.requestId, { "选哪个？": "A" });
    await pending;
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

  it("close() 释放挂起提问并上报已取消记录", async () => {
    const { s, ev, canUseTool } = await setup();
    const p = canUseTool("AskUserQuestion", ASK_INPUT);
    await new Promise((r) => setTimeout(r, 20));
    const req = (ev.log.find(([kind]) => kind === "ask") as [string, { requestId: string }])[1];
    await s.close();
    expect((await p).behavior).toBe("deny");
    expect(ev.log).toContainEqual(["interactionSettled", { requestId: req.requestId, outcome: "cancelled", decider: "close" }]);
  });

  it("abort() 将挂起提问结算为用户取消", async () => {
    const { s, ev, canUseTool } = await setup();
    s.send("开始");
    const p = canUseTool("AskUserQuestion", ASK_INPUT);
    const req = (ev.log.find(([kind]) => kind === "ask") as [string, { requestId: string }])[1];
    s.abort();
    expect((await p).behavior).toBe("deny");
    expect(ev.log).toContainEqual(["interactionSettled", { requestId: req.requestId, outcome: "cancelled", decider: "abort" }]);
    await s.close();
  });
  it("提问超时释放 SDK 并上报 timeout，不留下无结局卡片", async () => {
    vi.useFakeTimers();
    try {
      const { fn, calls } = fakeQuery([INIT, DONE]);
      const ev = stubEvents();
      const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
      const canUseTool = calls[0]!.options.canUseTool as (n: string, i: Record<string, unknown>) => Promise<{ behavior: string }>;
      const pending = canUseTool("AskUserQuestion", ASK_INPUT);
      const req = (ev.log.find(([kind]) => kind === "ask") as [string, { requestId: string }])[1];
      await vi.advanceTimersByTimeAsync(600_000);
      expect((await pending).behavior).toBe("deny");
      expect(ev.log).toContainEqual(["interactionSettled", { requestId: req.requestId, outcome: "timeout", decider: "timeout" }]);
      await s.close();
    } finally {
      vi.useRealTimers();
    }
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

  it("工具调用与结果按 toolUseId 关联，保留完整输入、输出和错误状态", async () => {
    const call = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu-bash-1", name: "Bash", input: { command: "printf ok" } }] },
    };
    const result = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu-bash-1", content: [{ type: "text", text: "第一行\n第二行" }] }] },
      tool_use_result: "第一行\n第二行",
    };
    const { fn } = fakeQuery([INIT, call, result, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "toolResult")).toBe(true));
    expect(ev.log).toContainEqual(["tool", "Bash:printf ok", { toolUseId: "toolu-bash-1", input: { command: "printf ok" } }]);
    expect(ev.log).toContainEqual(["toolResult", { toolUseId: "toolu-bash-1", output: "第一行\n第二行", isError: false }]);
    await s.close();
  });

  it("Edit 普通结果文本之外保留 structuredPatch 完整 diff", async () => {
    const call = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu-edit-patch", name: "Edit", input: { file_path: "a.txt", old_string: "旧行", new_string: "新行" } }] },
    };
    const result = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu-edit-patch", content: "文件已更新" }] },
      tool_use_result: {
        filePath: "a.txt", oldString: "旧行", newString: "新行",
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-旧行", "+新行", " 保留行"] }],
      },
    };
    const { fn } = fakeQuery([INIT, call, result, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "toolResult")).toBe(true));
    expect(ev.log).toContainEqual(["toolResult", {
      toolUseId: "toolu-edit-patch", isError: false,
      output: "文件已更新\n\n@@ -1,2 +1,2 @@\n-旧行\n+新行\n 保留行",
    }]);
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
    const req = (permLog as [string, { requestId: string; summary?: string }])[1];
    expect(req.summary).toBe("执行命令：ls");
    s.respondPermission(req.requestId, true);
    expect((await p).behavior).toBe("allow");
    await s.close();
  });

  it("requiresUserInteraction 的未适配工具安全拒绝，绝不进入通用允许卡", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "approve-each", events: ev, queryFn: fn });
    const canUseTool = calls[0]!.options.canUseTool as (
      n: string, i: Record<string, unknown>, metadata?: Record<string, unknown>,
    ) => Promise<{ behavior: string; message?: string }>;
    const result = await canUseTool("mcp__remote__custom_ui", { value: "x" }, {
      toolUseID: "toolu-custom-ui", requiresUserInteraction: true,
    });
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("专用用户交互");
    expect(ev.log.some(([kind]) => kind === "permission")).toBe(false);
    expect(ev.log).toContainEqual(["notice", expect.objectContaining({
      level: "warning", toolUseId: "toolu-custom-ui",
      text: expect.stringContaining("需要专用交互"),
    })]);
    await s.close();
  });

  it("已有专用卡片的 ExitPlanMode 不被 requiresUserInteraction 误拒", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "plan", events: ev, queryFn: fn });
    const canUseTool = calls[0]!.options.canUseTool as (
      n: string, i: Record<string, unknown>, metadata?: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    const pending = canUseTool("ExitPlanMode", { plan: "计划" }, {
      toolUseID: "toolu-plan-ui", requiresUserInteraction: true,
    });
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "permission")).toBe(true));
    const req = (ev.log.find(([kind]) => kind === "permission") as [string, { requestId: string }])[1];
    s.respondPermission(req.requestId, true);
    expect((await pending).behavior).toBe("allow");
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

  it("新会话首条斜杠命令保持原文，防注入前缀留给下一条普通消息", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    s.send("/compact");
    await new Promise((r) => setTimeout(r, 50));
    const stream = calls[0].prompt as AsyncIterable<{ message: { content: string } }>;
    const input = stream[Symbol.asyncIterator]();
    expect((await input.next()).value.message.content).toBe("/compact");
    s.send("你好");
    expect((await input.next()).value.message.content).toBe(GUARD_PREFIX + "你好");
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

  it("init/status 的 permissionMode 作为 CC 实际模式上报，不用请求值猜测", async () => {
    const init = { ...INIT, permissionMode: "auto" };
    const status = { type: "system", subtype: "status", status: null, permissionMode: "plan" };
    const { fn } = fakeQuery([init, status, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "auto", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 50));
    expect(ev.runtime.map((r) => r.permissionMode)).toEqual(["auto", "plan", "plan"]);
    expect(s.runtimeInfo().permissionMode).toBe("plan");
    await s.close();
  });

  it("plan 模式下 ExitPlanMode 仍进入审批，批准后由 SDK 继续处理", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "plan", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 30));
    const canUseTool = calls[0]!.options.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      metadata?: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;
    const pending = canUseTool("ExitPlanMode", {}, { toolUseID: "toolu-exit-1" });
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "permission")).toBe(true));
    const req = (ev.log.find(([kind]) => kind === "permission") as [string, { requestId: string; toolUseId?: string }])[1];
    expect(req.toolUseId).toBe("toolu-exit-1");
    s.respondPermission(req.requestId, true);
    expect((await pending).behavior).toBe("allow");
    await s.close();
  });

  it("ExitPlanMode 提供完整计划与路径，退回意见经 deny message 返回 CC", async () => {
    const { fn, calls } = fakeQuery([INIT, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "plan", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 30));
    const canUseTool = calls[0]!.options.canUseTool as (
      n: string,
      i: Record<string, unknown>,
      metadata?: Record<string, unknown>,
    ) => Promise<{ behavior: string; message?: string }>;
    const plan = "# 完整计划\n\n不得截断";
    const pending = canUseTool("ExitPlanMode", { plan, planFilePath: "D:\\plans\\full.md" }, { toolUseID: "toolu-exit-full" });
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "permission")).toBe(true));
    const req = (ev.log.find(([kind]) => kind === "permission") as [string, {
      requestId: string; kind?: string; plan?: string; planFilePath?: string; summary?: string;
    }])[1];
    expect(req).toMatchObject({
      kind: "exit_plan", plan, planFilePath: "D:\\plans\\full.md", summary: "申请批准计划并继续执行",
    });
    (s.respondPermission as (id: string, allow: boolean, feedback?: string) => void)(req.requestId, false, "请补充测试");
    expect(await pending).toEqual({ behavior: "deny", message: "请补充测试" });
    await s.close();
  });

  it("审批回调只有空参数时按 toolUseId 找回完整计划并用于批准", async () => {
    const plan = "# 完整计划\n\n真实回调关联";
    const input = { plan, planFilePath: "D:\\plans\\linked.md" };
    const { fn, calls } = fakeQuery([INIT, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu-exit-linked", name: "ExitPlanMode", input }] },
    }, DONE]);
    const ev = stubEvents();
    const s = createClaudeSession("D:\\notes", { permissionMode: "plan", events: ev, queryFn: fn });
    await new Promise((r) => setTimeout(r, 30));
    const canUseTool = calls[0]!.options.canUseTool as (
      n: string, i: Record<string, unknown>, metadata?: Record<string, unknown>,
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
    const pending = canUseTool("ExitPlanMode", {}, { toolUseID: "toolu-exit-linked" });
    await vi.waitFor(() => expect(ev.log.some(([kind]) => kind === "permission")).toBe(true));
    const req = (ev.log.find(([kind]) => kind === "permission") as [string, {
      requestId: string; plan?: string; planFilePath?: string; detail: string;
    }])[1];
    expect(req).toMatchObject({ plan, planFilePath: input.planFilePath, detail: JSON.stringify(input, null, 2) });
    s.respondPermission(req.requestId, true);
    expect(await pending).toEqual({ behavior: "allow", updatedInput: input });
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

describe("CLI 用户可见通知、拒绝与用量", () => {
  async function noticeSession(script: unknown[]) {
    const q = fakeQuery(script);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    await sleep(40);
    await s.close();
    return ev.log.filter(([kind]) => kind === "notice" || kind === "error" || kind === "done");
  }

  it("转发 API 重试、通知、informational 和本地命令输出", async () => {
    const log = await noticeSession([
      { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 1500, error_status: 429, error: "rate_limit" },
      { type: "system", subtype: "notification", key: "task", text: "后台任务完成", priority: "high" },
      { type: "system", subtype: "informational", content: "Hook 阻止继续", level: "warning", tool_use_id: "toolu-hook" },
      { type: "system", subtype: "local_command_output", content: "/usage 的完整输出" },
    ]);
    expect(log).toEqual([
      ["notice", { text: "API 请求失败，正在重试（第 2/5 次，等待 1.5 秒）", level: "warning", detail: "HTTP 429\nrate_limit" }],
      ["notice", { text: "后台任务完成", level: "info" }],
      ["notice", { text: "Hook 阻止继续", level: "warning", toolUseId: "toolu-hook" }],
      ["notice", { text: "/usage 的完整输出", level: "info", role: "assistant" }],
    ]);
  });

  it("自动拒权和限流保留中文摘要及完整原因", async () => {
    const log = await noticeSession([
      { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu-deny", decision_reason: "命中 deny 规则", message: "Denied by rule" },
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 100 } },
    ]);
    expect(log).toEqual([
      ["notice", { text: "操作被自动拒绝：Bash", level: "warning", toolUseId: "toolu-deny", detail: "命中 deny 规则\nDenied by rule" }],
      ["notice", { text: "API 使用限额已拒绝请求", level: "warning", detail: JSON.stringify({ status: "rejected", rateLimitType: "five_hour", utilization: 100 }, null, 2) }],
    ]);
  });

  it("Task、Hook 与长工具进度以可更新的稳定记录上报", async () => {
    const log = await noticeSession([
      { type: "system", subtype: "task_started", task_id: "task-1", description: "运行测试" },
      { type: "system", subtype: "task_progress", task_id: "task-1", description: "运行测试", summary: "正在跑 Vitest", last_tool_name: "Bash", usage: { total_tokens: 20, tool_uses: 1, duration_ms: 800 } },
      { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", summary: "全部通过", output_file: "D:\\task.log", usage: { total_tokens: 30, tool_uses: 2, duration_ms: 1200 } },
      { type: "system", subtype: "hook_started", hook_id: "hook-1", hook_name: "lint", hook_event: "PreToolUse" },
      { type: "system", subtype: "hook_response", hook_id: "hook-1", hook_name: "lint", hook_event: "PreToolUse", outcome: "error", stdout: "out", stderr: "bad", exit_code: 1 },
      { type: "tool_progress", tool_name: "Bash", tool_use_id: "toolu-long", elapsed_time_seconds: 12 },
    ]);
    expect(log).toEqual([
      ["notice", { id: "task-task-1", text: "任务开始：运行测试", level: "info" }],
      ["notice", {
        id: "task-task-1", text: "任务进度：正在跑 Vitest", level: "info",
        detail: JSON.stringify({ description: "运行测试", last_tool_name: "Bash", usage: { total_tokens: 20, tool_uses: 1, duration_ms: 800 } }, null, 2),
      }],
      ["notice", {
        id: "task-task-1", text: "任务已完成：全部通过", level: "info",
        detail: JSON.stringify({ status: "completed", output_file: "D:\\task.log", usage: { total_tokens: 30, tool_uses: 2, duration_ms: 1200 } }, null, 2),
      }],
      ["notice", { id: "hook-hook-1", text: "Hook 执行中：lint（PreToolUse）", level: "info" }],
      ["notice", {
        id: "hook-hook-1", text: "Hook 失败：lint", level: "warning",
        detail: JSON.stringify({ event: "PreToolUse", stdout: "out", stderr: "bad", exit_code: 1 }, null, 2),
      }],
      ["notice", { id: "tool-progress-toolu-long", text: "Bash 已执行 12 秒", level: "info", toolUseId: "toolu-long" }],
    ]);
  });

  it("Task 长报告只留完成状态在正文，完整报告与元数据进入折叠 detail", async () => {
    const report = "## 调查结果\n\n### 顶层清单\n\n完整子代理报告，不是用户发言。";
    const log = await noticeSession([
      { type: "system", subtype: "task_notification", task_id: "task-long", status: "completed", summary: report, output_file: "D:\\task.log" },
    ]);
    expect(log).toEqual([
      ["notice", {
        id: "task-task-long", text: "任务已完成：task-long", level: "info",
        detail: `${report}\n\n${JSON.stringify({ status: "completed", output_file: "D:\\task.log" }, null, 2)}`,
      }],
    ]);
  });

  it("requesting 状态实时上报并在空状态或本轮结束时清除", async () => {
    const q = fakeQuery([
      { type: "system", subtype: "status", status: "requesting" },
      { type: "system", subtype: "status", status: null },
      { type: "system", subtype: "status", status: "requesting" },
      DONE,
    ]);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    await sleep(40);
    expect(ev.log.filter(([kind]) => kind === "requesting")).toEqual([
      ["requesting", true], ["requesting", false], ["requesting", true], ["requesting", false],
    ]);
    await s.close();
  });

  it("认证进度、输出和错误保留为同一条可更新记录", async () => {
    const log = await noticeSession([
      { type: "auth_status", isAuthenticating: true, output: ["正在检查登录"], uuid: "u-1", session_id: "sid-auth" },
      { type: "auth_status", isAuthenticating: false, output: ["检查完成"], error: "登录已过期", uuid: "u-2", session_id: "sid-auth" },
    ]);
    expect(log).toEqual([
      ["notice", { id: "auth-status", text: "正在验证登录状态", level: "info", detail: "正在检查登录" }],
      ["notice", { id: "auth-status", text: "登录验证失败：登录已过期", level: "warning", detail: "检查完成\n登录已过期" }],
    ]);
  });

  it("init 的插件错误和未连接 MCP 服务不再静默丢弃", async () => {
    const log = await noticeSession([
      {
        ...INIT,
        plugin_errors: [{ plugin: "demo", type: "load", message: "入口不存在", path: "D:\\plugin" }],
        mcp_servers: [{ name: "ok", status: "connected" }, { name: "docs", status: "needs-auth", source: "project" }],
      },
    ]);
    expect(log).toEqual([
      ["notice", {
        id: "plugin-error-demo-load", text: "插件加载失败：demo", level: "warning",
        detail: JSON.stringify({ plugin: "demo", type: "load", message: "入口不存在", path: "D:\\plugin" }, null, 2),
      }],
      ["notice", {
        id: "mcp-server-docs", text: "MCP 服务未连接：docs（needs-auth）", level: "warning",
        detail: JSON.stringify({ name: "docs", status: "needs-auth", source: "project" }, null, 2),
      }],
    ]);
  });

  it("task_updated 使用任务稳定 ID 更新中文状态和完整 patch", async () => {
    const log = await noticeSession([
      { type: "system", subtype: "task_updated", task_id: "task-9", patch: { status: "running", description: "整理资料" } },
      { type: "system", subtype: "task_updated", task_id: "task-9", patch: { status: "failed", description: "整理资料", error: "磁盘不可写", total_paused_ms: 12 } },
    ]);
    expect(log).toEqual([
      ["notice", {
        id: "task-task-9", text: "任务执行中：整理资料", level: "info",
        detail: JSON.stringify({ status: "running", description: "整理资料" }, null, 2),
      }],
      ["notice", {
        id: "task-task-9", text: "任务失败：整理资料", level: "warning",
        detail: JSON.stringify({ status: "failed", description: "整理资料", error: "磁盘不可写", total_paused_ms: 12 }, null, 2),
      }],
    ]);
  });

  it("stderr 每行进入用户可见记录，同时仍写桥接诊断日志", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const q = fakeQuery([]);
      const ev = stubEvents();
      const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
      const stderr = q.calls[0]!.options.stderr as (line: string) => void;
      stderr("MCP server disconnected");
      expect(ev.log).toContainEqual(["notice", {
        id: "cli-stderr-1", text: "CLI 错误输出：MCP server disconnected", level: "warning", detail: "MCP server disconnected",
      }]);
      expect(error).toHaveBeenCalledWith("[claude-stderr]", "MCP server disconnected");
      await s.close();
    } finally {
      error.mockRestore();
    }
  });

  it("UserDialog 只声明已适配 kind，并返回 CLI 真实 completed/cancelled 结果", async () => {
    const q = fakeQuery([]);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    expect(q.calls[0]!.options.supportedDialogKinds).toEqual([
      "refusal_fallback_prompt", "auto_mode_server_fallback",
    ]);
    const onUserDialog = q.calls[0]!.options.onUserDialog as (
      request: Record<string, unknown>, options: { signal: AbortSignal; requestId: string },
    ) => Promise<unknown>;

    const refusal = onUserDialog({
      dialogKind: "refusal_fallback_prompt",
      payload: {
        originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8",
        apiRefusalCategory: "cyber", guidanceText: "可改用回退模型", retractedMessageUuids: [],
      },
    }, { signal: new AbortController().signal, requestId: "control-refusal" });
    expect(ev.log).toContainEqual(["userDialog", expect.objectContaining({
      requestId: "dialog-control-refusal", kind: "user_dialog",
      userDialog: expect.objectContaining({
        dialogKind: "refusal_fallback_prompt", originalModel: "claude-opus-5-5", fallbackModel: "claude-opus-4-8",
      }),
    })]);
    expect(s.respondUserDialog("dialog-control-refusal", { action: "retry_fallback" })).toBe(true);
    await expect(refusal).resolves.toEqual({ behavior: "completed", result: "retry_fallback" });

    const auto = onUserDialog({
      dialogKind: "auto_mode_server_fallback",
      payload: {
        gatewayHost: "127.0.0.1", title: "自动模式说明",
        paragraphs: ["分类器请求仍按原方式计费"], helpUrl: "https://example.com/auto-mode",
      },
    }, { signal: new AbortController().signal, requestId: "control-auto" });
    expect(s.respondUserDialog("dialog-control-auto", { action: "interrupt" })).toBe(true);
    await expect(auto).resolves.toEqual({ behavior: "completed", result: "interrupt" });
    expect(s.respondUserDialog("dialog-control-auto", { action: "continue" })).toBe(false);
    await s.close();
  });

  it("UserDialog 的取消、非法 payload 与关闭都有确定结局和中文记录", async () => {
    const q = fakeQuery([]);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    const onUserDialog = q.calls[0]!.options.onUserDialog as (
      request: Record<string, unknown>, options: { signal: AbortSignal; requestId: string },
    ) => Promise<unknown>;
    await expect(onUserDialog({
      dialogKind: "auto_mode_server_fallback", payload: { title: "缺字段" },
    }, { signal: new AbortController().signal, requestId: "bad-dialog" })).resolves.toEqual({ behavior: "cancelled" });
    expect(ev.log).toContainEqual(["notice", expect.objectContaining({
      level: "warning", text: expect.stringContaining("对话框结构"),
    })]);

    const pending = onUserDialog({
      dialogKind: "refusal_fallback_prompt",
      payload: { originalModel: "opus", fallbackModel: "sonnet" },
    }, { signal: new AbortController().signal, requestId: "close-dialog" });
    await s.close();
    await expect(pending).resolves.toEqual({ behavior: "cancelled" });
    expect(ev.log).toContainEqual(["interactionSettled", {
      requestId: "dialog-close-dialog", outcome: "cancelled", decider: "close",
    }]);
  });

  it("MCP form/url elicitation 转发结构化请求并返回真实用户裁决", async () => {
    const q = fakeQuery([]);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    const onElicitation = q.calls[0]!.options.onElicitation as (
      request: Record<string, unknown>, options: { signal: AbortSignal; requestId: string },
    ) => Promise<unknown>;
    const form = onElicitation({
      serverName: "docs", message: "请填写资料", mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "姓名", default: "Ada" },
          role: { type: "string", enum: ["admin", "user"] },
          enabled: { type: "boolean", default: true },
          age: { type: "integer" },
        },
        required: ["name", "role"],
      },
    }, { signal: new AbortController().signal, requestId: "control-form" });
    expect(ev.log).toContainEqual(["elicitation", expect.objectContaining({
      requestId: "elicitation-control-form", kind: "elicitation",
      elicitation: expect.objectContaining({
        mode: "form", serverName: "docs", message: "请填写资料",
        fields: [
          { name: "name", title: "姓名", type: "string", required: true, default: "Ada" },
          { name: "role", title: "role", type: "string", required: true, enum: ["admin", "user"] },
          { name: "enabled", title: "enabled", type: "boolean", required: false, default: true },
          { name: "age", title: "age", type: "integer", required: false },
        ],
      }),
    })]);
    s.respondElicitation("elicitation-control-form", { action: "accept", content: { name: "Grace", role: "admin", enabled: false, age: 36 } });
    await expect(form).resolves.toEqual({ action: "accept", content: { name: "Grace", role: "admin", enabled: false, age: 36 } });

    const url = onElicitation({
      serverName: "docs", message: "请登录", mode: "url", url: "https://example.com/auth?token=secret", elicitationId: "el-1",
    }, { signal: new AbortController().signal, requestId: "control-url" });
    expect(ev.log).toContainEqual(["elicitation", expect.objectContaining({
      requestId: "elicitation-control-url", elicitation: expect.objectContaining({ mode: "url", url: "https://example.com/auth?token=secret" }),
    })]);
    s.respondElicitation("elicitation-control-url", { action: "accept" });
    await expect(url).resolves.toEqual({ action: "accept" });
    await s.close();
  });

  it("非法 elicitation URL 和不支持的 schema 安全取消并留下中文原因", async () => {
    const q = fakeQuery([]);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    const onElicitation = q.calls[0]!.options.onElicitation as (
      request: Record<string, unknown>, options: { signal: AbortSignal; requestId: string },
    ) => Promise<unknown>;
    await expect(onElicitation({
      serverName: "docs", message: "请登录", mode: "url", url: "file:///C:/secret",
    }, { signal: new AbortController().signal, requestId: "bad-url" })).resolves.toEqual({ action: "cancel" });
    await expect(onElicitation({
      serverName: "docs", message: "请填写", mode: "form", requestedSchema: { type: "object", properties: { tags: { type: "array" } } },
    }, { signal: new AbortController().signal, requestId: "bad-schema" })).resolves.toEqual({ action: "cancel" });
    expect(ev.log.filter(([kind]) => kind === "notice").map(([, notice]) => (notice as { text: string }).text)).toEqual([
      "MCP URL 交互已取消：仅支持 http/https 地址",
      "MCP 表单交互已取消：请求结构包含暂不支持或非法的字段",
    ]);
    await s.close();
  });

  it("elicitation_complete 按服务和 elicitationId 转发完成事实", async () => {
    const q = fakeQuery([{ type: "system", subtype: "elicitation_complete", mcp_server_name: "docs", elicitation_id: "el-1" }]);
    const ev = stubEvents();
    const s = createClaudeSession(".", { permissionMode: "auto", queryFn: q.fn, events: ev });
    await sleep(30);
    expect(ev.log).toContainEqual(["elicitationComplete", { serverName: "docs", elicitationId: "el-1" }]);
    await s.close();
  });

  it("result 的错误正文、permission_denials 与累计用量不再丢失", async () => {
    const log = await noticeSession([
      {
        type: "result", subtype: "success", is_error: true, result: "API overloaded", session_id: "sid-result",
        num_turns: 2, duration_ms: 500, duration_api_ms: 400, total_cost_usd: 0.01,
        usage: { input_tokens: 12, output_tokens: 34 }, modelUsage: { opus: { inputTokens: 12, outputTokens: 34 } },
        permission_denials: [{ tool_name: "Write", tool_use_id: "toolu-result-deny", tool_input: { file_path: "a.txt" } }],
      },
    ]);
    expect(log).toEqual([
      ["notice", {
        text: "操作未获批准：Write", level: "warning", toolUseId: "toolu-result-deny",
        detail: JSON.stringify({ file_path: "a.txt" }, null, 2),
      }],
      ["notice", {
        text: "用量：输入 12 · 输出 34 tokens；模型往返 2 次；累计费用估算 $0.0100", level: "info",
        detail: JSON.stringify({
          usage: { input_tokens: 12, output_tokens: 34 }, modelUsage: { opus: { inputTokens: 12, outputTokens: 34 } },
          total_cost_usd: 0.01, num_turns: 2, duration_ms: 500, duration_api_ms: 400,
        }, null, 2),
      }],
      ["error", "API overloaded"],
    ]);
  });
});
