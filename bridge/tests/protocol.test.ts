import { describe, it, expect } from "vitest";
import { parseClientMessage, encode, isPermissionMode } from "../src/protocol";

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

describe("会话管理消息", () => {
  it("解析 session.list / session.new / session.switch / session.delete", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.list" }))).toEqual({ type: "session.list" });
    expect(parseClientMessage(JSON.stringify({ type: "session.new" }))).toEqual({ type: "session.new" });
    expect(parseClientMessage(JSON.stringify({ type: "session.switch", sessionId: "s1" }))).toEqual({ type: "session.switch", sessionId: "s1" });
    expect(parseClientMessage(JSON.stringify({ type: "session.delete", sessionId: "s1" }))).toEqual({ type: "session.delete", sessionId: "s1" });
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
