import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/lib/protocol";
import { shouldResetConversation } from "../src/lib/conversation-state";

type FolderBound = Extract<ServerMessage, { type: "folder.bound" }>;

function bound(reset?: boolean): FolderBound {
  return { type: "folder.bound", path: "D:/project", resumed: false, title: "", sessionId: null, ...(reset !== undefined ? { reset } : {}) };
}

describe("会话界面重置判定", () => {
  it("主动 reset 在首轮双方 sessionId 都为 null 时仍清旧界面", () => {
    expect(shouldResetConversation(bound(true), null, null)).toBe(true);
  });

  it("快照或重复绑定不误清，原有文件夹和会话变化判定保留", () => {
    expect(shouldResetConversation(bound(), null, null)).toBe(false);
    expect(shouldResetConversation(bound(), "D:/project", null)).toBe(false);
    expect(shouldResetConversation(bound(), "D:/other", null)).toBe(true);
    expect(shouldResetConversation({ ...bound(), sessionId: "new" }, "D:/project", "old")).toBe(true);
  });
});
