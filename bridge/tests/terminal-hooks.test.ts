import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { selectHookTransport } from "../src/cli-capabilities";
import { normalizeFolder } from "../src/session-manager";
import {
  parseHookEvent,
  handleTerminalHookHttp,
  readHookJson,
  safeTokenEqual,
  terminalSettings,
  validateHookEvent,
  writeTerminalSettings,
} from "../src/terminal-hooks";
import type { TerminalLeaseRecord } from "../src/terminal-lease";
import { slugifyPath, transcriptProjectsRoot } from "../src/transcript";

const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";
const work = path.resolve("hook-notes");
const projectsRoot = path.resolve("hook-projects");
const transcriptPath = path.join(
  projectsRoot,
  slugifyPath(path.resolve(work)),
  `${SID_2}.jsonl`,
);
const validPayload = {
  hook_event_name: "SessionStart",
  session_id: SID_2,
  cwd: work,
  transcript_path: transcriptPath,
  source: "resume",
} as const;
const tempDirs: string[] = [];

function makeRecord(): TerminalLeaseRecord {
  return {
    leaseId: LEASE_ID,
    hookToken: "test-hook-token",
    mode: "system",
    folder: work,
    initialSessionId: SID_1,
    resumeSessionId: SID_1,
    currentSessionId: SID_1,
    confirmedSessionId: null,
    cliPath: "C:/claude.exe",
    port: 19280,
    privateDir: "D:/private",
    phase: "starting",
    backend: null,
    pid: 1234,
    createdAt: "2026-11-10T00:00:00.000Z",
    canManualRelease: false,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CCC_FAKE_HOME;
});

describe("终端 Hook 安全", () => {
  it.each(["startup", "resume", "clear", "compact", "fork"] as const)(
    "接受 %s 的合法 SessionStart",
    (source) => {
      const event = parseHookEvent(JSON.stringify({ ...validPayload, source }));
      expect(event).toMatchObject({ event: "SessionStart", sessionId: SID_2, source });
    },
  );

  it("拒绝伪造 cwd、transcript、sessionId 和错误 token", () => {
    const record = makeRecord();
    const event = parseHookEvent(validPayload)!;
    expect(validateHookEvent(record, record.hookToken, event, projectsRoot)).toBeNull();
    expect(validateHookEvent(record, "wrong", event, projectsRoot)).toBe("TOKEN");
    expect(validateHookEvent(record, record.hookToken, {
      ...event,
      cwd: path.resolve("other"),
    }, projectsRoot)).toBe("CWD");
    expect(validateHookEvent(record, record.hookToken, {
      ...event,
      transcriptPath: path.resolve("other.jsonl"),
    }, projectsRoot)).toBe("TRANSCRIPT");
    expect(parseHookEvent({ ...validPayload, session_id: "../escape" })).toBeNull();
    expect(parseHookEvent({ ...validPayload, source: "unknown" })).toBeNull();
  });

  it("Windows 路径比较复用文件夹规范化，token 比较不泄露内容", () => {
    const expected = process.platform === "win32" ? path.resolve(work).toLowerCase() : path.resolve(work);
    expect(normalizeFolder(work)).toBe(expected);
    expect(safeTokenEqual("same", "same")).toBe(true);
    expect(safeTokenEqual("same", "different")).toBe(false);
  });

  it("Hook body 独立限制为 64 KiB", async () => {
    await expect(readHookJson(Readable.from(["{}"]))).resolves.toBe("{}");
    await expect(readHookJson(Readable.from(["x".repeat(65_537)])))
      .rejects.toThrow("HOOK_BODY_TOO_LARGE");
  });

  it("HTTP settings 使用独立 token，command settings 不包含 token", () => {
    const context = { ...makeRecord(), hookToken: "private-token" };
    const http = terminalSettings(context, "http");
    expect(JSON.stringify(http)).toContain("Bearer private-token");
    expect(JSON.stringify(http)).toContain(`/terminal-hook/${LEASE_ID}`);
    const command = terminalSettings(context, "command", "bridge --terminal-hook");
    expect(JSON.stringify(command)).not.toContain("private-token");
    expect(JSON.stringify(command)).toContain('"type":"command"');
    expect(() => terminalSettings(context, "command")).toThrow("HOOK_HELPER_REQUIRED");
  });

  it("私有 settings 和 command token 文件分别落盘", () => {
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-hook-settings-"));
    tempDirs.push(privateDir);
    const context = { ...makeRecord(), privateDir, hookToken: "private-token" };
    const settingsFile = writeTerminalSettings(context, "command", "bridge --terminal-hook");
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toMatchObject({ hooks: {} });
    expect(fs.readFileSync(path.join(privateDir, `${LEASE_ID}.hook-token`), "utf8"))
      .toBe("private-token");
  });

  it("HTTP 路由固定限制方法、token、事件归属和 64 KiB body", async () => {
    const record = makeRecord();
    const confirmed: string[] = [];
    const server = http.createServer((req, res) => {
      void handleTerminalHookHttp(req, res, {
        currentRecord: () => record,
        confirmSession: (leaseId, event) => {
          confirmed.push(`${leaseId}:${event.sessionId}`);
          return true;
        },
        projectsRoot,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const url = `http://127.0.0.1:${address.port}/terminal-hook/${LEASE_ID}`;
    const body = JSON.stringify(validPayload);
    try {
      expect((await fetch(url)).status).toBe(405);
      expect((await fetch(url, {
        method: "POST", headers: { Authorization: "Bearer wrong" }, body,
      })).status).toBe(401);
      expect((await fetch(url, {
        method: "POST", headers: { Authorization: `Bearer ${record.hookToken}` },
        body: JSON.stringify({ ...validPayload, transcript_path: path.resolve("other.jsonl") }),
      })).status).toBe(422);
      expect((await fetch(url, {
        method: "POST", headers: { Authorization: `Bearer ${record.hookToken}` }, body: "x".repeat(65_537),
      })).status).toBe(413);
      const accepted = await fetch(url, {
        method: "POST", headers: { Authorization: `Bearer ${record.hookToken}` }, body,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ code: "OK" });
      expect(confirmed).toEqual([`${LEASE_ID}:${SID_2}`]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });

  it("transcript 根目录复用现有隔离配置规则", () => {
    const fakeHome = path.resolve("fake-home");
    process.env.CCC_FAKE_HOME = fakeHome;
    expect(transcriptProjectsRoot()).toBe(path.join(fakeHome, ".claude", "projects"));
  });
});

describe("CLI Hook 能力选择", () => {
  it("未经真实探针验证的 HTTP 能力一律回退到已验证的 command", () => {
    // 本机 2.1.316 的 HTTP 探针超时，而 command 在同一隔离环境收到 SessionStart。
    expect(selectHookTransport("2.1.315")).toBe("command");
    expect(selectHookTransport("2.1.316")).toBe("command");
    expect(selectHookTransport("3.0.0")).toBe("command");
    expect(selectHookTransport("unknown")).toBe("command");
  });
});
