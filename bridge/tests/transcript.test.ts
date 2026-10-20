import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugifyPath, readTranscript } from "../src/transcript";

describe("slugifyPath", () => {
  it("Windows 路径转为 Claude 项目目录名", () => {
    expect(slugifyPath("D:\\SVN_Cursor\\chromeClaudeCode")).toBe("D--SVN-Cursor-chromeClaudeCode");
  });
});

describe("readTranscript", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
  const cwd = path.join("proj", "我的笔记");
  const sid = "sess-1";

  beforeEach(() => {
    process.env.CCC_FAKE_HOME = fakeHome; // 测试用假 home
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", message: { content: "这页讲了什么" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "讲了 X" }, { type: "tool_use", name: "Write", input: {} }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
      "bad line",
    ];
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join("\n"), "utf-8");
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("抽取 user/assistant 纯文本，跳过工具块与坏行", () => {
    const msgs = readTranscript(cwd, sid);
    expect(msgs).toEqual([
      { role: "user", text: "这页讲了什么" },
      { role: "assistant", text: "讲了 X" },
    ]);
  });

  it("文件不存在返回空数组", () => {
    expect(readTranscript(cwd, "no-such-session")).toEqual([]);
  });
});
