import { describe, it, expect } from "vitest";
import { parseClientMessage, encode, isPermissionMode, isFastModeState, isFastModeDisabledReason, sanitizeElicitationUrl, validateElicitationContent, type ServerMessage } from "../src/protocol";

describe("parseClientMessage", () => {
  it("解析合法消息", () => {
    expect(parseClientMessage(JSON.stringify({ type: "auth", token: "t" }))).toEqual({ type: "auth", token: "t" });
    expect(parseClientMessage(JSON.stringify({ type: "folder.bind", path: "/tmp/a" }))).toEqual({ type: "folder.bind", path: "/tmp/a" });
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi" }))).toEqual({ type: "chat.send", text: "hi" });
    expect(parseClientMessage(JSON.stringify({ type: "permission.response", requestId: "r1", allow: true }))).toEqual({ type: "permission.response", requestId: "r1", allow: true });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "approve-each" }))).toEqual({ type: "settings.set", permissionMode: "approve-each" });
  });

  it("拒绝非法输入返回 null，不抛异常", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage("{}")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "auth" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "root" }))).toBeNull();
  });
});

describe("isPermissionMode", () => {
  it("四档合法值", () => {
    for (const m of ["auto", "acceptEdits", "plan", "approve-each"]) expect(isPermissionMode(m)).toBe(true);
    expect(isPermissionMode("bypassPermissions")).toBe(false);
  });
});

describe("encode", () => {
  it("序列化服务消息", () => {
    expect(encode({ type: "auth.ok" })).toBe('{"type":"auth.ok"}');
  });

  it("chat.compact 两相帧字段保留", () => {
    const done = encode({ type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    expect(JSON.parse(done)).toEqual({ type: "chat.compact", phase: "done", result: "success", preTokens: 156_000, postTokens: 42_000 });
    const start = encode({ type: "chat.compact", phase: "start" });
    expect(JSON.parse(start)).toEqual({ type: "chat.compact", phase: "start" });
  });

  it("chat.ask 帧字段保留，chat.ask.answer 解析校验 answers", () => {
    const questions = [{ question: "选哪个？", header: "方案", options: [{ label: "A", description: "用 A" }], multiSelect: false }];
    expect(JSON.parse(encode({ type: "chat.ask", requestId: "ask-1", questions })))
      .toEqual({ type: "chat.ask", requestId: "ask-1", questions });
    expect(JSON.parse(encode({ type: "chat.ask.resolved", requestId: "ask-1" })))
      .toEqual({ type: "chat.ask.resolved", requestId: "ask-1" });
    expect(parseClientMessage(JSON.stringify({ type: "chat.ask.answer", requestId: "ask-1", answers: { "选哪个？": "A" } })))
      .toEqual({ type: "chat.ask.answer", requestId: "ask-1", answers: { "选哪个？": "A" } });
    expect(parseClientMessage(JSON.stringify({ type: "chat.ask.answer", requestId: "ask-1", answers: "A" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.ask.answer", requestId: "ask-1", answers: { q: 1 } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.ask.answer", requestId: "", answers: {} }))).toBeNull();
  });
});

describe("MCP elicitation 协议", () => {
  it("严格解析 accept/decline/cancel 与合法 content 类型", () => {
    expect(parseClientMessage(JSON.stringify({
      type: "chat.interaction.respond", requestId: "el-1",
      response: { action: "accept", content: { text: "值", count: 2, ok: true, tags: ["a"] } },
    }))).toEqual({
      type: "chat.interaction.respond", requestId: "el-1",
      response: { action: "accept", content: { text: "值", count: 2, ok: true, tags: ["a"] } },
    });
    for (const response of [
      { action: "open" }, { action: "accept", content: [] },
      { action: "accept", content: { count: Number.POSITIVE_INFINITY } },
      { action: "accept", content: { bad: { nested: true } } },
    ]) {
      expect(parseClientMessage(JSON.stringify({ type: "chat.interaction.respond", requestId: "el-1", response }))).toBeNull();
    }
  });

  it("共享表单校验覆盖必填、枚举、有限数字和整数", () => {
    const fields = [
      { name: "name", title: "名称", type: "string" as const, required: true, enum: ["a", "b"] },
      { name: "count", title: "数量", type: "integer" as const, required: true },
      { name: "ratio", title: "比例", type: "number" as const, required: false },
      { name: "ok", title: "确认", type: "boolean" as const, required: false },
    ];
    expect(validateElicitationContent(fields, { name: "a", count: 2, ratio: 0.5, ok: false })).toEqual([]);
    expect(validateElicitationContent(fields, {})).toContain("名称：必填");
    expect(validateElicitationContent(fields, { name: "c", count: 1.5 })).toEqual(expect.arrayContaining([
      "名称：不在可选值中", "数量：需要整数",
    ]));
    expect(validateElicitationContent(fields, { name: "a", count: 1, extra: "x" })).toContain("extra：不是请求中的字段");
  });

  it("URL 仅允许 http/https 并移除凭据、查询与片段", () => {
    expect(sanitizeElicitationUrl("https://user:pass@example.com/a?token=x#frag")).toBe("https://example.com/a");
    expect(sanitizeElicitationUrl("file:///C:/secret")).toBeNull();
    expect(sanitizeElicitationUrl("not a url")).toBeNull();
  });
});

describe("CLI UserDialog 协议", () => {
  it("只接受本机 CLI 已验证的对话框结果，禁止夹带表单 content", () => {
    for (const action of ["retry_fallback", "edit_prompt", "continue", "interrupt", "cancelled"]) {
      expect(parseClientMessage(JSON.stringify({
        type: "chat.interaction.respond", requestId: "dialog-1", response: { action },
      }))).toEqual({ type: "chat.interaction.respond", requestId: "dialog-1", response: { action } });
    }
    for (const response of [
      { action: "approve" },
      { action: "retry_fallback", content: { unexpected: true } },
      { action: "continue", content: "yes" },
    ]) {
      expect(parseClientMessage(JSON.stringify({
        type: "chat.interaction.respond", requestId: "dialog-1", response,
      }))).toBeNull();
    }
  });
});

describe("settings.set 扩展字段", () => {
  it("携带合法 model/effort 时透传", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "opus", effort: "high" })))
      .toEqual({ type: "settings.set", permissionMode: "auto", model: "opus", effort: "high" });
  });
  it("空串 model 与非法 effort 被剥掉", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", model: "", effort: "ultra" })))
      .toEqual({ type: "settings.set", permissionMode: "auto", model: undefined, effort: undefined });
  });
});

describe("settings.set 显式字段掩码", () => {
  it("只透传已知变更字段并去重，完整快照里的其他值不成为变更意图", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fields: ["model", "fastMode", "model", "bogus"] })))
      .toMatchObject({ fields: ["model", "fastMode"] });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fields: [] })))
      .toMatchObject({ fields: [] });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fields: "model" })))
      .toMatchObject({ fields: undefined });
  });
});

describe("会话管理消息", () => {
  it("解析 session.list / session.new / session.switch / session.delete", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.list" }))).toEqual({ type: "session.list" });
    expect(parseClientMessage(JSON.stringify({ type: "session.new" }))).toEqual({ type: "session.new" });
    expect(parseClientMessage(JSON.stringify({ type: "session.switch", sessionId: "s1" }))).toEqual({ type: "session.switch", sessionId: "s1" });
    expect(parseClientMessage(JSON.stringify({ type: "session.delete", sessionId: "s1" }))).toEqual({ type: "session.delete", sessionId: "s1" });
  });

  it("历史分页只接受有界 limit 与字符串游标", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.history", before: "history-u1-user", limit: 50 })))
      .toEqual({ type: "session.history", before: "history-u1-user", limit: 50 });
    expect(parseClientMessage(JSON.stringify({ type: "session.history", before: 1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "session.history", limit: 0 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "session.history", limit: 201 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "session.history", limit: 1.5 }))).toBeNull();
  });

  it("sessionId 缺失或为空返回 null", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.switch" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "session.delete", sessionId: "" }))).toBeNull();
  });
});

describe("chat.send 上传附件", () => {
  const up = (n: number): Array<{ name: string; dataB64: string }> =>
    Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, dataB64: "aGVsbG8=" }));

  it("合法 uploads 原样透传", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi", uploads: [{ name: "a.txt", dataB64: "aGVsbG8=" }] })))
      .toEqual({ type: "chat.send", text: "hi", uploads: [{ name: "a.txt", dataB64: "aGVsbG8=" }] });
  });

  it("空数组、数量越界、非法条目、非数组整帧拒绝", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi", uploads: [] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi", uploads: up(11) }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi", uploads: [{ name: "", dataB64: "aGVsbG8=" }] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi", uploads: [{ name: "a.txt" }] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "hi", uploads: "x" }))).toBeNull();
  });
});

describe("别名页面丰富度", () => {
  it("alias.create / alias.update 携带合法 pageRichness 透传，非法值剥掉", () => {
    expect(parseClientMessage(JSON.stringify({ type: "alias.create", name: "n", folder: "/tmp/x", sessionId: null, pageRichness: "rich" })))
      .toEqual({ type: "alias.create", name: "n", folder: "/tmp/x", sessionId: null, pageRichness: "rich" });
    expect(parseClientMessage(JSON.stringify({ type: "alias.create", name: "n", folder: "/tmp/x", sessionId: null, pageRichness: "mega" })))
      .toEqual({ type: "alias.create", name: "n", folder: "/tmp/x", sessionId: null });
    expect(parseClientMessage(JSON.stringify({ type: "alias.update", id: "a1", pageRichness: "brief" })))
      .toEqual({ type: "alias.update", id: "a1", pageRichness: "brief" });
    expect(parseClientMessage(JSON.stringify({ type: "alias.update", id: "a1", pageRichness: "mega" })))
      .toEqual({ type: "alias.update", id: "a1" });
  });
});

describe("镜像工作区新增消息", () => {
  it("chat.send 携带 display/note 透传；非法 display 与空 note 剥掉", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "full", display: "hi", note: "附带页面" })))
      .toEqual({ type: "chat.send", text: "full", display: "hi", note: "附带页面" });
    // 空串 display 合法（纯文件发送时没有用户输入文字）
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "full", display: "" })))
      .toEqual({ type: "chat.send", text: "full", display: "" });
    expect(parseClientMessage(JSON.stringify({ type: "chat.send", text: "full", display: 1, note: "" })))
      .toEqual({ type: "chat.send", text: "full" });
  });

  it("chat.draft：字符串且 ≤10 万字符，空串合法（清空草稿）", () => {
    expect(parseClientMessage(JSON.stringify({ type: "chat.draft", text: "草稿" }))).toEqual({ type: "chat.draft", text: "草稿" });
    expect(parseClientMessage(JSON.stringify({ type: "chat.draft", text: "" }))).toEqual({ type: "chat.draft", text: "" });
    expect(parseClientMessage(JSON.stringify({ type: "chat.draft" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.draft", text: 1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "chat.draft", text: "x".repeat(100_001) }))).toBeNull();
  });

  it("folder.open 无参解析", () => {
    expect(parseClientMessage(JSON.stringify({ type: "folder.open" }))).toEqual({ type: "folder.open" });
  });
});


describe("原生 fast 设置协议", () => {
  it("true 与显式 false 原样透传，缺省保持 undefined", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true })))
      .toMatchObject({ fastMode: true });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: false })))
      .toMatchObject({ fastMode: false });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto" })))
      .toMatchObject({ fastMode: undefined });
  });

  it("非法 fastMode 类型剥掉，不冒充用户关闭", () => {
    for (const fastMode of ["false", 0, 1, null, {}, []]) {
      expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode })))
        .toMatchObject({ fastMode: undefined });
    }
  });

  it("fast 状态与禁用原因严格匹配 CC 原生枚举", () => {
    for (const state of ["off", "cooldown", "on"]) expect(isFastModeState(state)).toBe(true);
    expect(isFastModeState("pending")).toBe(false);
    expect(isFastModeDisabledReason("model_not_allowed")).toBe(true);
    expect(isFastModeDisabledReason("cooldown")).toBe(false);
  });

  it("自动 hello 标志仅接受布尔 true，普通手动设置不携带", () => {
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", fastMode: true, hello: true })))
      .toMatchObject({ fastMode: true, hello: true });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", hello: false })))
      .toMatchObject({ hello: undefined });
    expect(parseClientMessage(JSON.stringify({ type: "settings.set", permissionMode: "auto", hello: "true" })))
      .toMatchObject({ hello: undefined });
  });

  it("settings.state 与 settings.error 服务消息可编码", () => {
    const state: ServerMessage = {
      type: "settings.state",
      permissionMode: "auto",
      fastMode: true,
      runtime: { model: "claude-opus-5-5", fast: { state: "cooldown", disabledReason: "network_error" } },
    };
    const error: ServerMessage = { type: "settings.error", message: "native rejected" };
    expect(encode(state)).toContain('"cooldown"');
    expect(encode(error)).toContain('"settings.error"');
  });
});
