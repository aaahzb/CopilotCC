import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AliasManager } from "../src/alias-manager";

/** 建临时别名文件路径（文件本身不存在） */
function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-")), "aliases.json");
}

describe("AliasManager", () => {
  it("创建并持久化：新实例 load 后仍在", () => {
    const f = tmpFile();
    const m = new AliasManager(f);
    const rec = m.create("  读书笔记 ", "D:\notes", "sid-1");
    expect(rec.name).toBe("读书笔记"); // 首尾空白裁剪
    expect(rec.id).toMatch(/^[0-9a-f]{16}$/);
    const m2 = new AliasManager(f);
    m2.load();
    expect(m2.all()).toHaveLength(1);
    expect(m2.get(rec.id)?.folder).toBe("D:\notes");
  });

  it("update 只改提供的字段；sessionId 可显式改 null（新会话）", () => {
    const m = new AliasManager(tmpFile());
    const rec = m.create("a", "/tmp/x", "sid-1");
    m.update(rec.id, { name: "b" });
    expect(m.get(rec.id)).toMatchObject({ name: "b", folder: "/tmp/x", sessionId: "sid-1" });
    m.update(rec.id, { sessionId: null });
    expect(m.get(rec.id)?.sessionId).toBeNull();
    expect(m.update("nope", { name: "x" })).toBeUndefined();
  });

  it("findByState 按规范化文件夹 + sessionId 匹配", () => {
    const m = new AliasManager(tmpFile());
    m.create("a", "/tmp/X", "sid-1");
    m.create("b", "/tmp/x", "sid-2");
    expect(m.findByState("/tmp/x", "sid-2")?.name).toBe("b");
    expect(m.findByState("/tmp/x", "nope")).toBeUndefined();
    if (process.platform === "win32") {
      expect(m.findByState("/TMP/x", "sid-1")?.name).toBe("a"); // NTFS 不区分大小写
    }
  });

  it("delete 只删别名并落盘；重复删返回 false", () => {
    const f = tmpFile();
    const m = new AliasManager(f);
    const rec = m.create("a", "/tmp/x", null);
    expect(m.delete(rec.id)).toBe(true);
    expect(m.delete(rec.id)).toBe(false);
    const m2 = new AliasManager(f);
    m2.load();
    expect(m2.all()).toHaveLength(0);
  });

  it("文件不存在时 load 为空列表，不抛错", () => {
    const m = new AliasManager(tmpFile());
    expect(() => m.load()).not.toThrow();
    expect(m.all()).toHaveLength(0);
  });

  it("pageRichness 随创建落盘、可更新、改其他字段时保留；未设置不落字段", () => {
    const f = tmpFile();
    const m = new AliasManager(f);
    const rec = m.create("a", "/tmp/x", "sid-1", "rich");
    expect(rec.pageRichness).toBe("rich");
    const m2 = new AliasManager(f); // 新实例重载：验证持久化
    m2.load();
    expect(m2.get(rec.id)?.pageRichness).toBe("rich");
    m2.update(rec.id, { sessionId: null }); // 改其他字段不影响丰富度
    expect(m2.get(rec.id)?.pageRichness).toBe("rich");
    m2.update(rec.id, { pageRichness: "brief" });
    expect(m2.get(rec.id)?.pageRichness).toBe("brief");
    expect(m.create("b", "/tmp/y", null).pageRichness).toBeUndefined(); // 未设置 = 标准档（不落字段）
  });
});
