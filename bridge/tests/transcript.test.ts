import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { slugifyPath, readTranscript, readTranscriptPage, listSessions, deleteTranscript, extractEffortFromTranscript, readTranscriptEffort } from "../src/transcript";
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

  it("工具结果按 tool_use_id 合并，完整输入、输出与失败状态可回放", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "toolu-read-1", name: "Read", input: { file_path: "a.txt", offset: 1 } },
        { type: "tool_use", id: "toolu-bash-1", name: "Bash", input: { command: "exit 2" } },
      ] } }),
      JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu-read-1", content: "完整第一行\n完整第二行" },
        { type: "tool_result", tool_use_id: "toolu-bash-1", content: "boom", is_error: true },
      ] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const messages = readTranscript(cwd, sid);
    expect(messages).toEqual([
      {
        role: "tool", toolName: "Read", text: "a.txt", toolUseId: "toolu-read-1",
        toolStatus: "success", toolInput: JSON.stringify({ file_path: "a.txt", offset: 1 }, null, 2), toolOutput: "完整第一行\n完整第二行",
      },
      {
        role: "tool", toolName: "Bash", text: "exit 2", toolUseId: "toolu-bash-1",
        toolStatus: "error", toolInput: JSON.stringify({ command: "exit 2" }, null, 2), toolOutput: "boom",
      },
    ]);
  });

  it("历史 Edit 结果保留 toolUseResult.structuredPatch 完整 diff", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu-edit-patch", name: "Edit", input: { file_path: "a.txt", old_string: "旧行", new_string: "新行" } }] } }),
      JSON.stringify({ type: "user", toolUseResult: {
        filePath: "a.txt", oldString: "旧行", newString: "新行",
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-旧行", "+新行", " 保留行"] }],
      }, message: { content: [{ type: "tool_result", tool_use_id: "toolu-edit-patch", content: "文件已更新" }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([{
      role: "tool", toolName: "Edit", text: "a.txt", toolUseId: "toolu-edit-patch", toolStatus: "success",
      toolInput: JSON.stringify({ file_path: "a.txt", old_string: "旧行", new_string: "新行" }, null, 2),
      toolOutput: "文件已更新\n\n@@ -1,2 +1,2 @@\n-旧行\n+新行\n 保留行",
    }]);
  });

  it("用户与助手长正文不截断", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const userText = `开头${"用".repeat(2500)}结尾`;
    const assistantText = `回答${"长".repeat(2500)}完`;
    const lines = [
      JSON.stringify({ type: "user", message: { content: userText } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: assistantText }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid).map((m) => m.text)).toEqual([userText, assistantText]);
  });

  it("AskUserQuestion 不回放原始参数，正文与其他工具顺序不变", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "选哪个？" }] } },
        { type: "text", text: "已收到选择" },
        { type: "tool_use", name: "Write", input: { file_path: "answer.md" } },
      ] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([
      { role: "assistant", text: "已收到选择" },
      { role: "tool", toolName: "Write", text: "answer.md" },
    ]);
  });

  it("Ask 历史按 tool_use_id 恢复实际答案，重复问题文本也不串答", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const questions1 = [{ question: "选哪个？", header: "方案", options: [{ label: "A", preview: "预览 A" }], multiSelect: false }];
    const questions2 = [{ question: "选哪个？", header: "方案", options: [{ label: "A" }, { label: "B" }], multiSelect: false }];
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu-ask-1", name: "AskUserQuestion", input: { questions: questions1 } }] } }),
      JSON.stringify({ type: "user", toolUseResult: { questions: questions1, answers: { "选哪个？": "A" } }, message: { content: [{ type: "tool_result", tool_use_id: "toolu-ask-1", content: "answered" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu-ask-2", name: "AskUserQuestion", input: { questions: questions2 } }] } }),
      JSON.stringify({ type: "user", toolUseResult: { questions: questions2, answers: { "选哪个？": "B" } }, message: { content: [{ type: "tool_result", tool_use_id: "toolu-ask-2", content: "answered" }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const messages = readTranscript(cwd, sid) as Array<{
      role: string;
      interaction?: { requestId: string; toolUseId?: string; answers?: Record<string, string>; questions?: unknown[] };
    }>;
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.interaction?.answers)).toEqual([{ "选哪个？": "A" }, { "选哪个？": "B" }]);
    expect(messages[0]!.interaction).toMatchObject({ kind: "ask", outcome: "answered", toolUseId: "toolu-ask-1", questions: questions1 });
    expect(JSON.stringify(messages)).not.toContain('"content":"answered"');
  });

  it("ExitPlanMode 历史恢复完整计划、文件路径以及批准或退回结果", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const approvedPlan = "# 已批准计划\n\n完整步骤";
    const deniedPlan = "# 待修改计划\n\n需要测试";
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu-plan-ok", name: "ExitPlanMode", input: { plan: approvedPlan, planFilePath: "D:\\plans\\ok.md" } }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-10-30T01:00:00.000Z", toolUseResult: { plan: approvedPlan, filePath: "D:\\plans\\ok.md", isAgent: false }, message: { content: [{ type: "tool_result", tool_use_id: "toolu-plan-ok", content: "User has approved your plan" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu-plan-no", name: "ExitPlanMode", input: { plan: deniedPlan, planFilePath: "D:\\plans\\no.md" } }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-10-30T01:01:00.000Z", toolUseResult: "请补充测试", message: { content: [{ type: "tool_result", tool_use_id: "toolu-plan-no", content: "请补充测试", is_error: true }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const messages = readTranscript(cwd, sid);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.interaction).toMatchObject({
      kind: "exit_plan", outcome: "allowed", toolUseId: "toolu-plan-ok",
      plan: approvedPlan, planFilePath: "D:\\plans\\ok.md", decider: "user",
    });
    expect(messages[1]?.interaction).toMatchObject({
      kind: "exit_plan", outcome: "denied", toolUseId: "toolu-plan-no",
      plan: deniedPlan, planFilePath: "D:\\plans\\no.md", feedback: "请补充测试", decider: "user",
    });
    expect(JSON.stringify(messages)).not.toContain("User has approved your plan");
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

  it("CLI isMeta 内部用户记录不冒充用户气泡，真实问题仍保留", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const internal = "Your response above was stopped by a safety classifier — this is not a tool or API error.";
    const lines = [
      JSON.stringify({ type: "user", uuid: "real-user", message: { content: "真实问题" } }),
      JSON.stringify({ type: "user", uuid: "internal-meta", parentUuid: "real-user", isMeta: true, message: { content: internal } }),
      JSON.stringify({ type: "assistant", uuid: "answer", message: { content: [{ type: "text", text: "真实回答" }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([
      { role: "user", text: "真实问题" },
      { role: "assistant", text: "真实回答" },
    ]);
  });

  it("compact summary 不冒充用户气泡，完整原文进入对应压缩记录的折叠详情", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const summary = "This session is being continued from a previous conversation.\n\n## 内部压缩摘要";
    const lines = [
      JSON.stringify({ type: "user", uuid: "real-before-compact", message: { content: "真实问题" } }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "boundary-summary", compactMetadata: {
        preTokens: 167008, postTokens: 5893, preservedSegment: { anchorUuid: "compact-summary" },
      } }),
      JSON.stringify({ type: "user", uuid: "compact-summary", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: summary } }),
      JSON.stringify({ type: "assistant", uuid: "answer-after-compact", message: { content: [{ type: "text", text: "压缩后的真实回答" }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([
      { role: "user", text: "真实问题" },
      { role: "tool", text: "🗜 已压缩上下文 167k → 6k tokens（-96%）", detail: summary },
      { role: "assistant", text: "压缩后的真实回答" },
    ]);
  });

  it("异步 task-notification 恢复为同 ID 折叠任务记录，不冒充用户且无需侧车也不丢报告", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const report = "## 调查结果\n\nSUBAGENT_REPORT_START\n完整报告\nSUBAGENT_REPORT_END";
    const summary = "Agent \"调查\" finished";
    const outputFile = "D:\\task.output";
    const usage = "<subagent_tokens>63</subagent_tokens><tool_uses>0</tool_uses>";
    const notification = `<task-notification>\n<task-id>task-async</task-id>\n<output-file>${outputFile}</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n<result>${report}</result>\n<usage>${usage}</usage>\n</task-notification>`;
    const lines = [
      JSON.stringify({ type: "user", uuid: "task-real-user", message: { content: "真实任务请求" } }),
      JSON.stringify({
        type: "user", uuid: "task-internal-notification", turnOrigin: "task_notification",
        origin: { kind: "task-notification", producer: "session-task" }, message: { content: notification },
      }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const page = readTranscriptPage(cwd, sid);
    const metadata = { status: "completed", summary, output_file: outputFile, usage };
    expect(page.messages).toEqual([
      { id: "history-task-real-user-user", createdAt: 0, role: "user", text: "真实任务请求" },
      {
        id: "task-task-async", createdAt: 0, role: "tool", text: "任务已完成：task-async",
        detail: `${report}\n\n${JSON.stringify(metadata, null, 2)}`,
      },
    ]);
  });

  it("旧版侧车把长报告写进 Task 正文时，读取迁移为短状态与折叠原文", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), "", "utf-8");
    const report = "## 调查结果：D:\\CopilotCC_Dir\n\n### 1. 顶层清单\n\n完整旧报告";
    const metadata = JSON.stringify({ status: "completed", usage: { total_tokens: 63 } }, null, 2);
    const page = readTranscriptPage(cwd, sid, {
      additional: [{
        id: "task-ab15aabdc55bfc5d5", createdAt: 1, role: "tool",
        text: `任务已完成：${report}`, detail: metadata,
      }],
    });
    expect(page.messages).toEqual([{
      id: "task-ab15aabdc55bfc5d5", createdAt: 1, role: "tool",
      text: "任务已完成：ab15aabdc55bfc5d5", detail: `${report}\n\n${metadata}`,
    }]);
  });

  it("普通用户手输相似 task 标签但没有 CLI 内部标记时仍保留用户气泡", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const typed = "<task-notification>\n<task-id>not-internal</task-id>\n<result>这是用户原文</result>\n</task-notification>";
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({
      type: "user", uuid: "typed-task-notification", message: { content: typed },
    }), "utf-8");
    expect(readTranscript(cwd, sid)).toEqual([{ role: "user", text: typed }]);
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

  it("分页返回稳定 ID，可用首项游标继续加载更早记录", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      type: "user", uuid: `message-${index + 1}`, timestamp: `2026-10-30T01:00:0${index}.000Z`,
      message: { content: `消息 ${index + 1}` },
    }));
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");

    const latest = readTranscriptPage(cwd, sid, { limit: 2 });
    expect(latest.messages.map((m) => m.text)).toEqual(["消息 4", "消息 5"]);
    expect(latest.messages.map((m) => m.id)).toEqual(["history-message-4-user", "history-message-5-user"]);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextCursor).toBe("history-message-4-user");

    const earlier = readTranscriptPage(cwd, sid, { limit: 2, before: latest.nextCursor });
    expect(earlier.messages.map((m) => m.text)).toEqual(["消息 2", "消息 3"]);
    expect(earlier.hasMore).toBe(true);
    const oldest = readTranscriptPage(cwd, sid, { limit: 2, before: earlier.nextCursor });
    expect(oldest.messages.map((m) => m.text)).toEqual(["消息 1"]);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextCursor).toBeUndefined();
    expect(readTranscriptPage(cwd, sid, { limit: 2 }).messages).toEqual(latest.messages);
  });

  it("合并侧车按稳定 ID 和 toolUseId 去重，再统一分页", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const questions = [{ question: "选哪个？", header: "方案", options: [{ label: "A" }], multiSelect: false }];
    const lines = [
      JSON.stringify({ type: "assistant", uuid: "ask-call", timestamp: "2026-10-30T01:00:00.000Z", message: { content: [{ type: "tool_use", id: "toolu-ask-merge", name: "AskUserQuestion", input: { questions } }] } }),
      JSON.stringify({ type: "user", uuid: "ask-result", timestamp: "2026-10-30T01:00:01.000Z", toolUseResult: { questions, answers: { "选哪个？": "A" } }, message: { content: [{ type: "tool_result", tool_use_id: "toolu-ask-merge", content: "answered" }] } }),
      JSON.stringify({ type: "system", uuid: "compact-merge", timestamp: "2026-10-30T01:00:02.000Z", subtype: "compact_boundary", compactMetadata: { preTokens: 100, postTokens: 50 } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const page = readTranscriptPage(cwd, sid, {
      limit: 2,
      additional: [
        {
          id: "interaction-live-ask", createdAt: Date.parse("2026-10-30T01:00:01.100Z"), role: "tool", text: "", toolUseId: "toolu-ask-merge",
          interaction: {
            requestId: "live-ask", kind: "ask", questions, answers: { "选哪个？": "A" },
            outcome: "answered", decider: "user", resolvedAt: Date.parse("2026-10-30T01:00:01.100Z"), toolUseId: "toolu-ask-merge",
          },
        },
        {
          id: "history-compact-merge-compact", createdAt: Date.parse("2026-10-30T01:00:02.000Z"),
          role: "tool", text: "🗜 已压缩上下文 100 → 50 tokens（-50%）", detail: "完整压缩信息",
        },
      ],
    });
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]).toMatchObject({ id: "interaction-live-ask", toolUseId: "toolu-ask-merge" });
    expect(page.messages[0]?.interaction).toMatchObject({ requestId: "live-ask", answers: { "选哪个？": "A" } });
    expect(page.messages[1]).toMatchObject({ id: "history-compact-merge-compact", detail: "完整压缩信息" });
    expect(page.hasMore).toBe(false);
  });
  it("实时与转录的同一压缩只保留一条，并使用实时稳定 ID 对接快照", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const boundaryTime = Date.parse("2026-10-31T01:00:02.000Z");
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({
      type: "system", subtype: "compact_boundary", uuid: "compact-live-merge",
      timestamp: new Date(boundaryTime).toISOString(), compactMetadata: { preTokens: 167008, postTokens: 5893 },
    }), "utf-8");
    const page = readTranscriptPage(cwd, sid, {
      additional: [{
        id: "status-live-compact", createdAt: boundaryTime + 23, role: "tool",
        text: "🗜 已压缩上下文 167k → 6k tokens（-96%）",
      }],
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      id: "status-live-compact", createdAt: boundaryTime + 23,
      text: "🗜 已压缩上下文 167k → 6k tokens（-96%）",
    });
  });

  it("相同 token 文案但时间不同的两次压缩不会互相吞并", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const firstTime = Date.parse("2026-10-31T01:00:02.000Z");
    const secondTime = firstTime + 60_000;
    const meta = { preTokens: 100, postTokens: 50 };
    const lines = [firstTime, secondTime].map((time, index) => JSON.stringify({
      type: "system", subtype: "compact_boundary", uuid: `compact-distinct-${index + 1}`,
      timestamp: new Date(time).toISOString(), compactMetadata: meta,
    }));
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const page = readTranscriptPage(cwd, sid, {
      additional: [{
        id: "status-first-compact", createdAt: firstTime + 23, role: "tool",
        text: "🗜 已压缩上下文 100 → 50 tokens（-50%）",
      }],
    });
    expect(page.messages.map((item) => item.id)).toEqual([
      "status-first-compact", "history-compact-distinct-2-compact",
    ]);
  });

  it("侧车权限记录不覆盖同 toolUseId 的转录工具结果", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "assistant", uuid: "write-call", timestamp: "2026-10-30T01:00:00.000Z", message: { content: [{ type: "tool_use", id: "toolu-write-merge", name: "Write", input: { file_path: "D:\\notes\\a.txt", content: "完整内容" } }] } }),
      JSON.stringify({ type: "user", uuid: "write-result", timestamp: "2026-10-30T01:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu-write-merge", content: "写入成功" }] } }),
    ];
    fs.writeFileSync(path.join(dir, sid + ".jsonl"), lines.join("\n"), "utf-8");
    const page = readTranscriptPage(cwd, sid, {
      additional: [{
        id: "interaction-live-write", createdAt: Date.parse("2026-10-30T01:00:00.500Z"), role: "tool", text: "", toolUseId: "toolu-write-merge",
        interaction: {
          requestId: "live-write", kind: "permission", tool: "Write", toolUseId: "toolu-write-merge",
          outcome: "allowed", decider: "user", resolvedAt: Date.parse("2026-10-30T01:00:00.500Z"),
        },
      }],
    });
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]).toMatchObject({
      toolName: "Write", toolUseId: "toolu-write-merge", toolStatus: "success", toolOutput: "写入成功",
    });
    expect(page.messages[0]?.interaction).toBeUndefined();
    expect(page.messages[1]?.interaction).toMatchObject({ requestId: "live-write", outcome: "allowed" });
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

  it("会话标题跳过内部压缩与任务通知，继续寻找真实用户问题", () => {
    const dir = path.join(fakeHome, ".claude", "projects", slugifyPath(path.resolve(cwd)));
    const lines = [
      JSON.stringify({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: "This session is being continued from a previous conversation." } }),
      JSON.stringify({ type: "user", turnOrigin: "task_notification", origin: { kind: "task-notification" }, message: { content: "<task-notification><result>内部子代理报告</result></task-notification>" } }),
      JSON.stringify({ type: "user", message: { content: "压缩后的真实标题" } }),
    ];
    fs.writeFileSync(path.join(dir, "sid-b.jsonl"), lines.join("\n"), "utf-8");
    expect(listSessions(cwd).find((session) => session.sessionId === "sid-b")?.title).toBe("压缩后的真实标题");
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
