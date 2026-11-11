import { describe, expect, it } from "vitest";
import { reduceTerminalMirror, type TerminalMirrorView } from "../src/lib/terminal-mirror";
import type { ServerMessage } from "../src/lib/protocol";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";

function mirror(sessionId: string, revision: number): Extract<ServerMessage, { type: "session.mirror.data" }> {
  return {
    type: "session.mirror.data", sessionId, revision,
    messages: [{ id: "new-item", createdAt: 3, role: "user", text: "新会话" }], hasMore: false,
  };
}

describe("终端只读镜像 reducer", () => {
  it("旧 revision 不覆盖新页面，最新页更新工具结果且保留已加载旧页", () => {
    const older = [{ id: "history-old", createdAt: 1, role: "user" as const, text: "旧页" }];
    const running = [{ id: "history-tool", createdAt: 2, role: "tool" as const, text: "Read", toolStatus: "running" as const }];
    const view: TerminalMirrorView = {
      sessionId: SID_1, revision: 4, messages: [...older, ...running], hasLoadedOlder: true,
    };
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

  it("只有切换 sessionId 才清空旧会话视图，其他 sessionId 一律忽略", () => {
    const view: TerminalMirrorView = {
      sessionId: SID_1, revision: 9,
      messages: [{ id: "old-item", role: "user", text: "旧会话" }], hasLoadedOlder: true,
    };
    expect(reduceTerminalMirror(view, mirror(SID_2, 100), SID_1)).toBe(view);
    const next = reduceTerminalMirror(view, mirror(SID_2, 1), SID_2);
    expect(next.messages.map((m) => m.id)).toEqual(["new-item"]);
    expect(next.hasLoadedOlder).toBe(false);
  });
});
