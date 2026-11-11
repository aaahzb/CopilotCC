import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalLeaseRecord } from "../src/terminal-lease";
import { TerminalLeaseStore } from "../src/terminal-store";

const LEASE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_LEASE_ID = "44444444-4444-4444-8444-444444444444";
const SID = "11111111-1111-4111-8111-111111111111";
const tempDirs: string[] = [];

function fixture(): { store: TerminalLeaseStore; file: string; record: TerminalLeaseRecord } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-terminal-store-"));
  tempDirs.push(dir);
  const file = path.join(dir, "system-lease.json");
  return {
    store: new TerminalLeaseStore(file),
    file,
    record: {
      leaseId: LEASE_ID,
      hookToken: "A".repeat(43),
      mode: "system",
      folder: "D:/notes",
      initialSessionId: SID,
      resumeSessionId: SID,
      currentSessionId: SID,
      confirmedSessionId: SID,
      cliPath: "C:/claude.exe",
      port: 19280,
      privateDir: dir,
      phase: "active",
      backend: "windows-terminal",
      pid: 1234,
      createdAt: "2026-11-10T00:00:00.000Z",
      canManualRelease: false,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TerminalLeaseStore", () => {
  it("原子保存并完整加载私有记录", () => {
    const { store, record } = fixture();
    store.save(record);
    expect(store.load()).toEqual(record);
    expect(store.load()?.hookToken).toBe(record.hookToken);
  });

  it("坏 JSON 和字段不完整记录返回 null", () => {
    const { store, file, record } = fixture();
    fs.writeFileSync(file, "{bad", "utf8");
    expect(store.load()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...record, leaseId: "../escape" }), "utf8");
    expect(store.load()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...record, port: -1 }), "utf8");
    expect(store.load()).toBeNull();
  });

  it("Windows 暂时占用目标文件时重试替换，不丢失后端身份", () => {
    const { store, record } = fixture();
    store.save(record);
    const rename = fs.renameSync.bind(fs);
    let attempts = 0;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("模拟 Windows 目标文件暂时占用") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      rename(oldPath, newPath);
    }) as typeof fs.renameSync);
    const identity = { pid: 5678, executable: "C:/fake/claude.exe", startedAt: "2026-11-10T08:00:00.000Z" };
    expect(() => store.save({ ...record, pid: 5678, identity })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(store.load()).toMatchObject({ pid: 5678, identity });
  });

  it("旧 lease 清理不会删除新记录", () => {
    const { store, file, record } = fixture();
    store.save(record);
    store.clear(OTHER_LEASE_ID);
    expect(fs.existsSync(file)).toBe(true);
    expect(store.load()?.leaseId).toBe(LEASE_ID);
    store.clear(LEASE_ID);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.load()).toBeNull();
  });
});
