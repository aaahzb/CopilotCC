import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableStartupTiming, StartupTiming } from "../src/startup-timing";

/** 每个用例使用独立临时目录，避免碰真实用户配置目录。 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-startup-timing-"));
  enableStartupTiming(null); // 缺省关闭：未启用的入口绝不落盘
});

afterEach(() => {
  enableStartupTiming(null);
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 读取当前日志的所有非空行。 */
function readLines(): string[] {
  const file = path.join(dir, "startup.log");
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

describe("StartupTiming 启动耗时日志", () => {
  it("未启用全局日志目录时不创建任何文件", async () => {
    const timing = new StartupTiming("embedded");
    timing.mark("probe");
    await timing.flush();
    expect(fs.existsSync(path.join(dir, "startup.log"))).toBe(false);
  });

  it("按段追加毫秒耗时，第二次 flush 只写新增阶段并保留累计 total", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T00:00:00.000Z"));
    enableStartupTiming(dir);
    const timing = new StartupTiming("embedded");
    vi.advanceTimersByTime(49);
    timing.mark("probe");
    vi.advanceTimersByTime(180);
    timing.mark("spawn");
    await timing.flush();
    vi.advanceTimersByTime(1000);
    timing.mark("firstOutput");
    await timing.flush();
    expect(readLines()).toEqual([
      "2026-11-15T00:00:00.229Z [startup] embedded probe=49ms spawn=180ms total=229ms",
      "2026-11-15T00:00:01.229Z [startup] embedded firstOutput=1000ms total=1229ms",
    ]);
  });

  it("没有新阶段时 flush 不追加空行", async () => {
    enableStartupTiming(dir);
    const timing = new StartupTiming("system");
    await timing.flush();
    expect(readLines()).toEqual([]);
  });

  it("标签只接受安全字符，非法值被丢弃", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T00:00:00.000Z"));
    enableStartupTiming(dir);
    const timing = new StartupTiming("system");
    timing.tag("backend", "windows-terminal");
    timing.tag("backend", "bad value; rm -rf /");
    timing.tag("bad name", "x");
    vi.advanceTimersByTime(20);
    timing.mark("probe");
    await timing.flush();
    const [line] = readLines();
    expect(line).toBe(
      "2026-11-15T00:00:00.020Z [startup] system backend=windows-terminal probe=20ms total=20ms",
    );
  });

  it("日志目录不可写时静默完成，不向启动链抛错", async () => {
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    enableStartupTiming(blocker);
    const timing = new StartupTiming("terminal-child");
    timing.mark("identity");
    await expect(timing.flush()).resolves.toBeUndefined();
  });
});
