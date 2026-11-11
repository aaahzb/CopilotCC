import { describe, expect, it } from "vitest";
import { TerminalService, type TerminalServiceDeps } from "../src/terminal-service";
import type { ServerMessage } from "../src/protocol";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";

function fixture(): {
  service: TerminalService;
  sent: ServerMessage[];
  listed: number;
} {
  const sent: ServerMessage[] = [];
  const state = { listed: 0 };
  const records = new Map<string, { sessionId: string; title: string; updatedAt: string }>();
  const deps: TerminalServiceDeps = {
    sessions: {
      get: (folder: string) => records.get(folder),
      set: (folder: string, record: { sessionId: string; title: string; updatedAt: string }) => {
        records.set(folder, record);
      },
    } as unknown as TerminalServiceDeps["sessions"],
    getWorkspace: () => ({
      folder: "D:/notes", currentAliasId: null, busy: false, pendingCount: 0, sessionId: SID_1,
    }),
    suspendSdk: async () => {},
    restoreSdk: () => {},
    readHistoryPage: (_folder, sessionId) => ({
      messages: [{ id: `history-${sessionId}`, createdAt: 1, role: "user", text: sessionId }],
      hasMore: false,
    }),
    broadcast: (message) => sent.push(message),
    pushSessionList: () => { state.listed += 1; },
    syncCurrentAlias: () => {},
    pushAliasList: () => {},
    configDir: "D:/private",
    privateDir: "D:/private",
    getPort: () => 19280,
    resolveCli: () => "C:/claude.exe",
    system: async () => { throw new Error("unused"); },
    prepareRecovery: () => {},
  };
  return { service: new TerminalService(deps), sent, get listed() { return state.listed; } };
}

describe("TerminalService 镜像", () => {
  it("只镜像 lease 当前会话，revision 单调递增", async () => {
    const { service, sent } = fixture();
    const state = await service.leases.open({
      folder: "D:/notes", initialSessionId: SID_1, cliPath: "C:/claude.exe", port: 19280,
      privateDir: "D:/private", mode: "system",
    }, async () => ({
      pid: 1234, backend: "windows-terminal", onExit: () => {}, stop: async () => {},
    }));
    service.pushMirror(SID_1);
    service.leases.confirmSession(state.leaseId!, {
      event: "SessionStart", sessionId: SID_2, cwd: "D:/notes",
      transcriptPath: "D:/home/projects/D--notes/" + SID_2 + ".jsonl", source: "clear",
    });
    service.pushMirror(SID_1); // 旧会话即使刚写文件也不能抢占当前镜像
    service.pushMirror(SID_2);
    service.pushMirror(SID_2);
    const mirrors = sent.filter((m) => m.type === "session.mirror.data");
    // Hook 切会话本身先推一次 SID_2，随后两次显式推送继续递增；旧 SID_1 没有第二包。
    expect(mirrors.map((m) => m.type === "session.mirror.data" ? [m.sessionId, m.revision] : null))
      .toEqual([[SID_1, 1], [SID_2, 1], [SID_2, 2], [SID_2, 3]]);
    await service.leases.completeExit(state.leaseId!, 0);
    service.close();
  });
});
