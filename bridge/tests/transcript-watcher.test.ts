import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptWatcher } from "../src/transcript-watcher";
import { slugifyPath } from "../src/transcript";

const SID_1 = "11111111-1111-4111-8111-111111111111";
const SID_2 = "22222222-2222-4222-8222-222222222222";
const tempDirs: string[] = [];

function fixture(): { work: string; transcript: (sessionId: string) => string } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-watch-home-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-watch-work-"));
  tempDirs.push(fakeHome, work);
  process.env.CCC_FAKE_HOME = fakeHome;
  const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(work)));
  fs.mkdirSync(dir, { recursive: true });
  return { work, transcript: (sessionId) => path.join(dir, `${sessionId}.jsonl`) };
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CCC_FAKE_HOME;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TranscriptWatcher", () => {
  it("防抖合并写入，幂等对账区分列表和当前转录变化", async () => {
    vi.useFakeTimers();
    const { work, transcript } = fixture();
    const changed: string[] = [];
    const listed: string[] = [];
    const watcher = new TranscriptWatcher({
      debounceMs: 250,
      reconcileMs: 2000,
      onList: () => listed.push("list"),
      onTranscript: (sessionId) => changed.push(sessionId),
    });
    watcher.bind(work);
    await vi.advanceTimersByTimeAsync(10);
    fs.writeFileSync(transcript(SID_1), "{}\n", "utf8");
    fs.appendFileSync(transcript(SID_1), "{}\n", "utf8");
    await vi.advanceTimersByTimeAsync(250);
    // watch 事件只调度同一对账；手工调用与周期计时器走完全相同的生产路径。
    watcher.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(listed).toHaveLength(1);
    expect(changed).toEqual([SID_1]);
    watcher.reconcile();
    expect(listed).toHaveLength(1);
    expect(changed).toEqual([SID_1]);
    fs.writeFileSync(transcript(SID_2), "{}\n", "utf8");
    watcher.reconcile();
    expect(listed).toHaveLength(2);
    expect(changed).toEqual([SID_1, SID_2]);
    fs.unlinkSync(transcript(SID_2));
    watcher.reconcile();
    expect(listed).toHaveLength(3);
    expect(changed).toEqual([SID_1, SID_2]);
    watcher.close();
  });

  it("周期对账发现 watch 丢失的新文件，目录后出现时补挂监听", async () => {
    vi.useFakeTimers();
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-watch-late-home-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-watch-late-work-"));
    tempDirs.push(fakeHome, work);
    process.env.CCC_FAKE_HOME = fakeHome;
    const changed: string[] = [];
    const listed: string[] = [];
    const watcher = new TranscriptWatcher({
      debounceMs: 250,
      reconcileMs: 2000,
      onList: () => listed.push("list"),
      onTranscript: (sessionId) => changed.push(sessionId),
    });
    watcher.bind(work);
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(work)));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID_1}.jsonl`), "{}\n", "utf8");
    await vi.advanceTimersByTimeAsync(2000);
    expect(listed).toHaveLength(1);
    expect(changed).toEqual([SID_1]);
    watcher.close();
    watcher.close();
  });
});
