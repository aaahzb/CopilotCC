import { describe, it, expect } from "vitest";
import { formatSize, validateFiles, MAX_FILES, MAX_FILE_BYTES } from "../src/lib/upload-files";

describe("formatSize", () => {
  it("B/KB/MB 分档", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("validateFiles", () => {
  it("合法清单返回 null", () => {
    expect(validateFiles([{ name: "a.txt", size: 100 }, { name: "b.png", size: 2000 }])).toBeNull();
  });

  it("超过数量上限", () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}`, size: 1 }));
    expect(validateFiles(many)).toContain("最多");
  });

  it("单文件超上限报文件名", () => {
    expect(validateFiles([{ name: "big.zip", size: MAX_FILE_BYTES + 1 }])).toContain("big.zip");
  });

  it("单文件都没超但总大小超上限", () => {
    // 两个都在 30MB 内、合计超 45MB
    const files = [
      { name: "a", size: MAX_FILE_BYTES - 1_000_000 },
      { name: "b", size: MAX_FILE_BYTES - 5_000_000 },
    ];
    expect(validateFiles(files)).toContain("总大小");
  });
});
