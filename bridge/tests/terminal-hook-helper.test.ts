import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runTerminalHookHelper } from "../src/terminal-hook-helper";

const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const payload = {
  hook_event_name: "SessionStart",
  session_id: "22222222-2222-4222-8222-222222222222",
  cwd: "D:/notes",
  transcript_path: "D:/home/projects/D--notes/22222222-2222-4222-8222-222222222222.jsonl",
  source: "resume",
};

describe("terminal command Hook helper", () => {
  it("从 stdin 转发同一事件，token 只从私有环境读取", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    await runTerminalHookHelper({
      stdin: Readable.from([JSON.stringify(payload)]),
      env: {
        CCC_TERMINAL_HOOK_URL: `http://127.0.0.1:19280/terminal-hook/${LEASE_ID}`,
        CCC_TERMINAL_HOOK_TOKEN: "secret",
      },
      fetchImpl: fetchMock,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(`/terminal-hook/${LEASE_ID}`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(payload));
    expect(JSON.stringify(init)).toContain("Bearer secret");
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("拒绝非回环 URL、缺失 token 和超大 stdin", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(runTerminalHookHelper({
      stdin: Readable.from(["{}"]),
      env: { CCC_TERMINAL_HOOK_URL: "https://example.com/hook", CCC_TERMINAL_HOOK_TOKEN: "secret" },
      fetchImpl: fetchMock,
    })).rejects.toThrow();
    await expect(runTerminalHookHelper({
      stdin: Readable.from(["{}"]),
      env: {
        CCC_TERMINAL_HOOK_URL: "http://127.0.0.1:19280/hook",
        CCC_TERMINAL_HOOK_TOKEN: undefined,
      },
      fetchImpl: fetchMock,
    })).rejects.toThrow("HOOK_HELPER_CONFIG");
    await expect(runTerminalHookHelper({
      stdin: Readable.from(["x".repeat(65_537)]),
      env: {
        CCC_TERMINAL_HOOK_URL: "http://127.0.0.1:19280/hook",
        CCC_TERMINAL_HOOK_TOKEN: "secret",
      },
      fetchImpl: fetchMock,
    })).rejects.toThrow("HOOK_BODY_TOO_LARGE");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
