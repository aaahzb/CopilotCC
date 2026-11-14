import { describe, expect, it } from "vitest";
import * as processIdentity from "../src/process-identity";
import {
  matchesProcessIdentity,
  parseMacProcessIdentity,
  parseWindowsProcessIdentity,
  readProcessIdentity,
} from "../src/process-identity";

const identity = {
  pid: 1234,
  executable: "C:/bridge/ccc-bridge.exe",
  startedAt: "2026-11-10T08:00:00.000Z",
};

describe("进程身份", () => {
  it("解析 Windows 路径和 UTC 启动时间，不能只看 PID", () => {
    expect(parseWindowsProcessIdentity(
      "C:\\bridge\\ccc-bridge.exe\r\n2026-11-10T08:00:00.0000000Z\r\n",
      1234,
    )).toEqual(identity);
    expect(parseWindowsProcessIdentity("", 1234)).toBeNull();
  });

  it("解析 macOS comm/lstart，并严格比较路径和启动时间", async () => {
    const parsed = parseMacProcessIdentity(
      "/Applications/ccc-bridge.app/Contents/MacOS/ccc-bridge Tue Nov 10 08:00:00 2026\n",
      1234,
    );
    expect(parsed?.pid).toBe(1234);
    expect(parsed?.executable).toContain("ccc-bridge");
    expect(await matchesProcessIdentity(identity, async () => identity)).toBe(true);
    expect(await matchesProcessIdentity(identity, async () => ({ ...identity, pid: 1234, executable: "C:/other.exe" })))
      .toBe(false);
    expect(await matchesProcessIdentity(identity, async () => null)).toBe(false);
  });

  const itMac = process.platform === "darwin" ? it : it.skip;
  itMac("真实 macOS ps 在中文 Locale 下仍返回当前进程身份", async () => {
    const names = ["LC_ALL", "LC_TIME", "LANG"] as const;
    const saved = names.map((name) => [name, process.env[name]] as const);
    try {
      process.env.LC_ALL = "zh_CN.UTF-8";
      process.env.LC_TIME = "zh_CN.UTF-8";
      process.env.LANG = "zh_CN.UTF-8";
      const actual = await readProcessIdentity(process.pid, "darwin");
      expect(actual).toMatchObject({ pid: process.pid });
      expect(actual?.executable).toBeTruthy();
      expect(Number.isFinite(Date.parse(actual?.startedAt ?? ""))).toBe(true);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("只有 ESRCH 证明进程退出，权限或其他探测错误保持未知", () => {
    const candidate = (processIdentity as unknown as {
      isProcessAlive?: (pid: number, probe?: (pid: number) => void) => boolean;
    }).isProcessAlive;
    expect(candidate).toBeTypeOf("function");
    const failure = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(candidate?.(1234, failure("ESRCH"))).toBe(false);
    expect(candidate?.(1234, failure("EPERM"))).toBe(true);
    expect(candidate?.(1234, failure("EIO"))).toBe(true);
    expect(candidate?.(1234, () => {})).toBe(true);
    expect(candidate?.(0, () => { throw new Error("不得探测非法 PID"); })).toBe(false);
  });
});
