import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, normalizeFolder, isValidFolder } from "../src/session-manager";

const rec = { sessionId: "s1", title: "t", updatedAt: "2026-10-20" };

describe("session-manager", () => {
  it("set 后 get 命中，且落盘持久化", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
    const file = path.join(dir, "sessions.json");
    const m1 = new SessionManager(file);
    m1.set("D:\\notes", rec);
    const m2 = new SessionManager(file);
    m2.load();
    expect(m2.get("D:\\notes")).toEqual(rec);
  });

  it("normalizeFolder 解析为绝对路径，Windows 下统一小写", () => {
    const n = normalizeFolder(".");
    expect(path.isAbsolute(n)).toBe(true);
    if (process.platform === "win32") {
      expect(normalizeFolder("D:\\Notes")).toBe(normalizeFolder("d:\\notes"));
    }
  });

  it("isValidFolder 区分目录/文件/不存在", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
    expect(isValidFolder(dir)).toBe(true);
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "x");
    expect(isValidFolder(f)).toBe(false);
    expect(isValidFolder(path.join(dir, "nope"))).toBe(false);
  });

  it("load 时文件不存在不抛错，get 未命中返回 undefined", () => {
    const m = new SessionManager(path.join(os.tmpdir(), "ccc-nonexist-", "s.json"));
    expect(() => m.load()).not.toThrow();
    expect(m.get("whatever")).toBeUndefined();
  });
});
