import { describe, expect, it } from "vitest";
import * as processIdentity from "../src/process-identity";
import {
  matchesProcessIdentity,
  parseMacProcessIdentity,
  parseWindowsProcessIdentity,
  readProcessIdentity,
  selfProcessIdentity,
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

  it("Windows 自报身份不启动外部查询，恢复核对时容许初始化偏差", async () => {
    // 包装进程自身身份不能依赖 PowerShell：CI 满载时冷启动可超过 8 秒。
    const self = selfProcessIdentity("win32");
    expect(self).toMatchObject({ pid: process.pid, startedAtSource: "self" });
    expect(self?.executable.replace(/\\/g, "/").toLowerCase())
      .toBe(process.execPath.replace(/\\/g, "/").toLowerCase());
    // macOS 继续使用快速且精确的 ps，不需要自报路径。
    expect(selfProcessIdentity("darwin")).toBeNull();

    const expected = {
      pid: 4321,
      executable: "C:/Program Files/nodejs/node.exe",
      startedAt: "2026-11-16T12:00:00.000Z",
      startedAtSource: "self" as const,
    };
    // 自报时间取自 Node 初始化时刻，与 OS 创建时间相差初始化耗时；路径和时间距离仍须核验。
    expect(await matchesProcessIdentity(expected, async () => ({
      ...expected, startedAt: "2026-11-16T12:00:05.000Z",
    }))).toBe(true);
    expect(await matchesProcessIdentity(expected, async () => ({
      ...expected, startedAt: "2026-11-16T12:01:00.000Z",
    }))).toBe(false);
    expect(await matchesProcessIdentity(expected, async () => ({
      ...expected, executable: "C:/other/node.exe",
    }))).toBe(false);
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

  const itWin = process.platform === "win32" ? it : it.skip;
  itWin("真实 Windows 查询不依赖 WMI，返回当前进程路径与启动时间", async () => {
    const actual = await readProcessIdentity(process.pid, "win32");
    expect(actual).toMatchObject({ pid: process.pid });
    // Get-Process 与 process.execPath 必须指向同一个原生程序；路径分隔符和大小写不敏感。
    expect(actual?.executable.replace(/\\/g, "/").toLowerCase())
      .toBe(process.execPath.replace(/\\/g, "/").toLowerCase());
    expect(Number.isFinite(Date.parse(actual?.startedAt ?? ""))).toBe(true);
  });

  itWin("Windows 查询不存在的 PID 返回 null，而不是抛出原始异常", async () => {
    await expect(readProcessIdentity(2_147_483_647, "win32")).resolves.toBeNull();
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
