import { describe, expect, it, vi } from "vitest";
import {
  TerminalLeaseManager,
  type TerminalLeaseEvents,
  type TerminalRuntimeHandle,
} from "../src/terminal-lease";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";

function runtime(
  exit: (fn: (code: number | null, reason?: string) => void) => void,
): TerminalRuntimeHandle {
  return {
    pid: 1234,
    backend: "windows-terminal",
    onExit: exit,
    stop: vi.fn(async () => {}),
  };
}

function events(overrides: Partial<TerminalLeaseEvents> = {}): TerminalLeaseEvents {
  return {
    onState: () => {},
    onSession: () => {},
    onMirror: () => {},
    onRestore: () => {},
    onError: () => {},
    ...overrides,
  };
}

describe("TerminalLeaseManager", () => {
  it("按 starting→active→stopping→idle 迁移，公开状态不含 token", async () => {
    let exited: (code: number | null) => void = () => {};
    const states: string[] = [];
    const restored: Array<string | null> = [];
    const order: string[] = [];
    const manager = new TerminalLeaseManager(events({
      onState: (state) => {
        states.push(state.phase);
        expect(JSON.stringify(state)).not.toContain("hookToken");
      },
      onMirror: (sessionId) => { order.push(`mirror:${sessionId}`); },
      onRestore: (sessionId) => {
        restored.push(sessionId);
        order.push(`restore:${sessionId}`);
      },
    }));
    const opened = await manager.open({
      folder: "D:/notes",
      initialSessionId: SID_1,
      cliPath: "C:/claude.exe",
      port: 19280,
      privateDir: "D:/private",
      mode: "system",
    }, () => Promise.resolve(runtime((fn) => { exited = fn; })));

    expect(opened.phase).toBe("starting");
    expect(manager.confirmSession(opened.leaseId!, {
      event: "SessionStart",
      sessionId: SID_2,
      cwd: "D:/notes",
      source: "resume",
      transcriptPath: `D:/home/projects/D--notes/${SID_2}.jsonl`,
    })).toBe(true);
    expect(manager.publicState().currentSessionId).toBe(SID_2);
    await manager.requestStop(opened.leaseId!);
    exited(0);
    await vi.waitFor(() => expect(manager.publicState().phase).toBe("idle"));
    expect(restored).toEqual([SID_2]);
    expect(states).toEqual(["starting", "active", "stopping", "idle"]);
    expect(order).toEqual([`mirror:${SID_2}`, `restore:${SID_2}`]);
  });

  it("SessionEnd 不释放 lease，启动失败恢复初始会话", async () => {
    const restored: Array<string | null> = [];
    const manager = new TerminalLeaseManager(events({
      onRestore: (sessionId) => { restored.push(sessionId); },
    }));
    await expect(manager.open({
      folder: "D:/notes",
      initialSessionId: SID_1,
      cliPath: "missing",
      port: 1,
      privateDir: "D:/private",
      mode: "system",
    }, () => Promise.reject(new Error("spawn failed")))).rejects.toThrow("spawn failed");
    expect(manager.publicState().phase).toBe("idle");
    expect(restored).toEqual([SID_1]);

    const active = new TerminalLeaseManager(events());
    const opened = await active.open({
      folder: "D:/notes",
      initialSessionId: SID_1,
      cliPath: "C:/claude.exe",
      port: 19280,
      privateDir: "D:/private",
      mode: "system",
    }, () => Promise.resolve(runtime(() => {})));
    expect(active.confirmSession(opened.leaseId!, {
      event: "SessionEnd",
      sessionId: SID_1,
      cwd: "D:/notes",
      reason: "clear",
      transcriptPath: `D:/home/projects/D--notes/${SID_1}.jsonl`,
    })).toBe(true);
    expect(active.publicState().phase).toBe("starting");
  });

  it("已有 lease 时拒绝第二个写入者", async () => {
    const manager = new TerminalLeaseManager(events());
    const input = {
      folder: "D:/notes",
      initialSessionId: SID_1,
      cliPath: "C:/claude.exe",
      port: 19280,
      privateDir: "D:/private",
      mode: "system" as const,
    };
    await manager.open(input, () => Promise.resolve(runtime(() => {})));
    await expect(manager.open(input, () => Promise.resolve(runtime(() => {}))))
      .rejects.toThrow("ALREADY_ACTIVE");
  });

  it("10 秒无有效 SessionStart 进入 degraded，有效事件可恢复 active", async () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const manager = new TerminalLeaseManager(events({
        onError: (code) => { errors.push(code); },
      }));
      const opened = await manager.open({
        folder: "D:/notes",
        initialSessionId: SID_1,
        cliPath: "C:/claude.exe",
        port: 19280,
        privateDir: "D:/private",
        mode: "system",
      }, () => Promise.resolve(runtime(() => {})));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.publicState()).toMatchObject({
        phase: "degraded",
        canManualRelease: false,
        currentSessionId: SID_1,
      });
      expect(errors).toEqual(["HOOK_DEGRADED"]);
      expect(manager.confirmSession(opened.leaseId!, {
        event: "SessionStart",
        sessionId: SID_2,
        cwd: "D:/notes",
        source: "resume",
        transcriptPath: `D:/home/projects/D--notes/${SID_2}.jsonl`,
      })).toBe(true);
      expect(manager.publicState().phase).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });
});
