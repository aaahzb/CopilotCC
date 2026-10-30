import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugifyPath, readTranscript, listSessions, deleteTranscript, extractEffortFromTranscript, readTranscriptEffort } from "../src/transcript";
import { GUARD_PREFIX } from "../src/claude-session";

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
    process.env.CCC_FAKE_HOME = fakeHome;
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", message: { content: "这页讲了什么" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "讲了 X" }, { type: "tool_use", name: "Write", input: { file_path: "a.md" } }] } }),
      JSON.stringify({ type: "result", subtype: "success" }),
      "bad line",
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("保留 user/assistant 文本和工具活动，跳过坏行", () => {
    const msgs = readTranscript(cwd, sid);
    expect(msgs).toEqual([
      { role: "user", text: "这页讲了什么" },
      { role: "assistant", text: "讲了 X" },
      { role: "tool", toolName: "Write", text: "a.md" },
    ]);
  });

  it("同一 assistant 内按 content 顺序恢复工具和正文", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", name: "Write", input: { file_path: "simpleTable.md" } },
        { type: "text", text: "已写入简介" },
      ] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([
      { role: "tool", toolName: "Write", text: "simpleTable.md" },
      { role: "assistant", text: "已写入简介" },
    ]);
  });

  it("本地命令按真实父子关系合并，用户主动输入的相似标签保持正文", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const caveatId = "caveat-1";
    const commandId = "command-1";
    const commandText = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>";
    const lines = [
      JSON.stringify({ type: "user", uuid: caveatId, parentUuid: "parent-0", isMeta: true, message: { content: "<local-command-caveat>CLI context only</local-command-caveat>" } }),
      JSON.stringify({ type: "user", uuid: commandId, parentUuid: caveatId, message: { content: commandText } }),
      JSON.stringify({ type: "user", uuid: "stdout-1", parentUuid: commandId, message: { content: "<local-command-stdout>Set model to claude-sonnet-5-5</local-command-stdout>" } }),
      JSON.stringify({ type: "user", uuid: "typed-1", parentUuid: "stdout-1", message: { content: commandText } }),
      JSON.stringify({ type: "user", uuid: "typed-2", parentUuid: "typed-1", message: { content: "普通问题" } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([
      { role: "tool", toolName: "/model", text: "sonnet → Set model to claude-sonnet-5-5" },
      { role: "user", text: commandText },
      { role: "user", text: "普通问题" },
    ]);
  });

  it("compact_boundary 按原顺序回放为压缩记录行", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "user", message: { content: "压缩前的问题" } }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 168069, postTokens: 8809, durationMs: 53355 } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "压缩后的回答" }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([
      { role: "user", text: "压缩前的问题" },
      { role: "tool", text: "🗜 已压缩上下文 168k → 9k tokens（-95%）" },
      { role: "assistant", text: "压缩后的回答" },
    ]);
  });

  it("compact_boundary 缺元数据时退化为简单文案", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([{ role: "tool", text: "🗜 已压缩上下文" }]);
  });

  it("compact_boundary 负压缩率省略百分比（与实时记录行同口径）", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 3, postTokens: 879 } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([{ role: "tool", text: "🗜 已压缩上下文 3 → 879 tokens" }]);
  });

  it("文件不存在返回空数组", () => {
    expect(readTranscript(cwd, "no-such-session")).toEqual([]);
  });
});

describe("readTranscript 拆解桥接发送包装", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
  const cwd = path.join("proj", "笔记");
  const sid = "sess-wrap";
  const GUARD = GUARD_PREFIX; // 与 claude-session 同源：前缀文案改动不再拖垮夹具

  beforeEach(() => {
    process.env.CCC_FAKE_HOME = fakeHome;
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
    const page = "[页面上下文 url=https://a.b 标题=T]\n正文内容\n\n[用户问题]\n这页讲了什么";
    const wrapped = GUARD + page;
    const selOnly = "[选中文字]\n某段文字\n\n[用户问题]\n解释这段话";
    const upload = "[上传文件] 用户上传了 1 个文件，已保存到当前工作目录下的 copilotUploads 目录，需要用 Read 工具查看：\n- D:\\proj\\copilotUploads\\a.png\n\n[用户问题]\n描述这张图";
    const plain = "交互式 CLI 直接发的消息";
    const lines = [wrapped, selOnly, upload, plain].map((t) => JSON.stringify({ type: "user", message: { content: t } }));
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join("\n"), "utf-8");
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("气泡只显示用户问题；完整发送内容保留在 sentText 供溯源，并给出附带标记；无标记消息原样保留", () => {
    expect(readTranscript(cwd, sid)).toEqual([
      {
        role: "user",
        text: "这页讲了什么",
        sentText: "[页面上下文 url=https://a.b 标题=T]\n正文内容\n\n[用户问题]\n这页讲了什么",
        attachKind: "full",
      },
      {
        role: "user",
        text: "解释这段话",
        sentText: "[选中文字]\n某段文字\n\n[用户问题]\n解释这段话",
        attachKind: "selection",
      },
      {
        role: "user",
        text: "描述这张图",
        sentText: "[上传文件] 用户上传了 1 个文件，已保存到当前工作目录下的 copilotUploads 目录，需要用 Read 工具查看：\n- D:\\proj\\copilotUploads\\a.png\n\n[用户问题]\n描述这张图",
        attachKind: "upload",
      },
      { role: "user", text: "交互式 CLI 直接发的消息" },
    ]);
  });
});

describe("listSessions / deleteTranscript", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
  const cwd = path.join("proj", "会话");

  beforeEach(() => {
    process.env.CCC_FAKE_HOME = fakeHome;
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
    // 两个会话：sid-a 带桥接包装，sid-b 纯文本；mtime 调成 sid-a 更旧
    fs.writeFileSync(path.join(dir, "sid-a.jsonl"), JSON.stringify({ type: "user", message: { content: "[页面上下文 url=https://a.b 标题=T]\n正文\n\n[用户问题]\n第一个问题" } }), "utf-8");
    fs.writeFileSync(path.join(dir, "sid-b.jsonl"), JSON.stringify({ type: "user", message: { content: "第二个问题" } }), "utf-8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, "sid-a.jsonl"), past, past);
    fs.writeFileSync(path.join(dir, "not-a-session.txt"), "x", "utf-8"); // 非 jsonl 应被忽略
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("枚举会话：标题取首条用户消息（拆包装），按 mtime 倒序，忽略非 jsonl", () => {
    const list = listSessions(cwd);
    expect(list.map((s) => s.sessionId)).toEqual(["sid-b", "sid-a"]);
    expect(list[0].title).toBe("第二个问题");
    expect(list[1].title).toBe("第一个问题");
    expect(typeof list[0].updatedAt).toBe("number");
  });

  it("deleteTranscript 删除文件并防路径穿越", () => {
    expect(deleteTranscript(cwd, "sid-a")).toBe(true);
    expect(listSessions(cwd).map((s) => s.sessionId)).toEqual(["sid-b"]);
    expect(deleteTranscript(cwd, "sid-a")).toBe(false); // 已不存在
    expect(deleteTranscript(cwd, "../evil")).toBe(false); // 路径穿越被拒
  });
});

describe("extractEffortFromTranscript", () => {
  it("最近一次 api-request-blob 带 effort 时返回该值（最后一处为准，每回答粒度）", () => {
    const t = [
      `{"type":"api-request-blob","body":{"effort":"high"}}`,
      `{"type":"assistant","message":{}}`,
      `{"type":"api-request-blob","body":{"effort":"max"}}`,
      `{"type":"result","subtype":"success"}`,
    ].join("\n");
    expect(extractEffortFromTranscript(t)).toBe("max");
  });

  it("最近一次 blob 无 effort 字段时返回 null（该会话不下发 effort 参数）", () => {
    const t = [
      `{"type":"api-request-blob","body":{"effort":"high"}}`,
      `{"type":"api-request-blob","body":{"model":"claude-fable-5-1"}}`,
    ].join("\n");
    expect(extractEffortFromTranscript(t)).toBeNull();
  });

  it("全文没有 api-request-blob 时返回 undefined（无证据，不覆盖 init 值）", () => {
    expect(extractEffortFromTranscript(`{"type":"assistant"}`)).toBeUndefined();
  });
});

describe("readTranscriptEffort", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-home-"));
  const cwd = path.join("proj", "笔记");
  const sid = "sess-eff";

  beforeEach(() => {
    process.env.CCC_FAKE_HOME = fakeHome;
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `{"type":"api-request-blob","body":{"effort":"low"}}\n`, "utf-8");
  });

  afterEach(() => {
    delete process.env.CCC_FAKE_HOME;
  });

  it("按 cwd+sessionId 定位转录并读取末尾 effort", () => {
    expect(readTranscriptEffort(cwd, sid)).toBe("low");
  });

  it("会话不存在 / 非法 sessionId 返回 undefined", () => {
    expect(readTranscriptEffort(cwd, "no-such")).toBeUndefined();
    expect(readTranscriptEffort(cwd, "../evil")).toBeUndefined(); // 路径穿越被拒
  });
});
