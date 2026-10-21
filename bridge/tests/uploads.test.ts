import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveUploads, sanitizeUploadName, MAX_UPLOAD_BYTES } from "../src/uploads";
import { composeUploadNote, UPLOAD_DIR } from "../src/upload-note";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-upload-"));
});

/** 字符串转 base64（测试夹具） */
function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

describe("sanitizeUploadName", () => {
  it("路径穿越只留 basename，控制字符剥除，非法返回 null", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("..\\..\\win\\evil.txt")).toBe("evil.txt");
    expect(sanitizeUploadName("a\nb.png")).toBe("ab.png");
    expect(sanitizeUploadName("")).toBeNull();
    expect(sanitizeUploadName("..")).toBeNull();
  });
});

describe("saveUploads", () => {
  it("创建 copilotUploads 目录并原样写入字节", () => {
    const r = saveUploads(dir, [{ name: "a.txt", dataB64: b64("hello 世界") }]);
    expect(r.failed).toEqual([]);
    expect(r.saved).toHaveLength(1);
    const target = path.join(dir, UPLOAD_DIR, "a.txt");
    expect(r.saved[0].path).toBe(target);
    expect(fs.readFileSync(target, "utf-8")).toBe("hello 世界");
  });

  it("路径穿越文件名只落在目录内", () => {
    const r = saveUploads(dir, [{ name: "../../evil.txt", dataB64: b64("x") }]);
    expect(r.saved[0].path).toBe(path.join(dir, UPLOAD_DIR, "evil.txt"));
  });

  it("重名加 -1 后缀且不覆盖旧文件", () => {
    saveUploads(dir, [{ name: "a.txt", dataB64: b64("old") }]);
    const r = saveUploads(dir, [{ name: "a.txt", dataB64: b64("new") }]);
    expect(r.saved[0].path).toBe(path.join(dir, UPLOAD_DIR, "a-1.txt"));
    expect(fs.readFileSync(path.join(dir, UPLOAD_DIR, "a.txt"), "utf-8")).toBe("old");
    expect(fs.readFileSync(r.saved[0].path, "utf-8")).toBe("new");
  });

  it("坏 base64、空文件、超上限分别进 failed，合法文件不受影响", () => {
    const r = saveUploads(dir, [
      { name: "bad.txt", dataB64: "!!!" },
      { name: "empty.txt", dataB64: "" },
      // "A" 重复 N 次是合法 base64，解码后恰超 30MB（长度须为 4 的倍数才过格式校验）
      { name: "big.bin", dataB64: "A".repeat(41_943_044) },
      { name: "ok.txt", dataB64: b64("ok") },
    ]);
    expect(r.failed.map((f) => f.name)).toEqual(["bad.txt", "empty.txt", "big.bin"]);
    expect(r.failed.map((f) => f.reason)).toEqual(["数据编码损坏", "空文件", "超过 30MB 上限"]);
    expect(r.saved.map((s) => s.name)).toEqual(["ok.txt"]);
  });
});

describe("composeUploadNote", () => {
  it("含 [上传文件] 标记、数量、目录名与逐行路径", () => {
    const note = composeUploadNote(["D:\\p\\copilotUploads\\a.png", "D:\\p\\copilotUploads\\b.pdf"]);
    expect(note.startsWith("[上传文件]")).toBe(true);
    expect(note).toContain("2 个文件");
    expect(note).toContain(UPLOAD_DIR);
    expect(note).toContain("- D:\\p\\copilotUploads\\a.png\n- D:\\p\\copilotUploads\\b.pdf");
  });
});
