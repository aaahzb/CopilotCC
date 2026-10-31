import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InteractionStore } from "../src/interaction-store";
import type { TimelineItem } from "../src/protocol";

/** 构造只读状态时间线项。 */
function status(id: string, text: string, createdAt: number): TimelineItem {
  return { id, createdAt, role: "tool", text };
}

describe("InteractionStore", () => {
  it("按文件夹和会话隔离保存，稳定 ID 更新不重复且保留首次位置", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-interactions-"));
    const store = new InteractionStore(root);
    store.append("D:\\project-a", "sid-1", status("status-mode", "当前模式：计划模式", 1));
    store.append("D:\\project-a", "sid-1", status("status-usage", "用量：输入 10", 2));
    store.append("D:\\project-a", "sid-1", {
      ...status("status-mode", "当前模式：标准确认", 3), detail: "完整原因",
    });
    store.append("D:\\project-a", "sid-2", status("status-other", "另一会话", 4));
    store.append("D:\\project-b", "sid-1", status("status-folder", "另一文件夹", 5));

    expect(store.read("D:\\project-a", "sid-1")).toEqual([
      { ...status("status-mode", "当前模式：标准确认", 3), detail: "完整原因" },
      status("status-usage", "用量：输入 10", 2),
    ]);
    expect(store.read("D:\\project-a", "sid-2").map((item) => item.text)).toEqual(["另一会话"]);
    expect(store.read("D:\\project-b", "sid-1").map((item) => item.text)).toEqual(["另一文件夹"]);
    expect(store.read("D:\\project-a", "missing")).toEqual([]);
  });

  it("恢复 MCP 裁决与 URL 完成状态，拒绝把表单 content 写入可读历史", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-interactions-"));
    const store = new InteractionStore(root);
    const base: TimelineItem = {
      id: "interaction-el-1", createdAt: 1, role: "tool", text: "",
      interaction: {
        requestId: "el-1", kind: "elicitation", outcome: "answered", resolvedAt: 2,
        decider: "user", elicitationAction: "accept", submittedFields: ["name"],
        elicitation: {
          serverName: "docs", message: "请填写", mode: "form",
          fields: [{ name: "name", title: "姓名", type: "string", required: true }],
        },
      },
    };
    store.append("project", "sid-1", base);
    expect(store.read("project", "sid-1")).toEqual([base]);

    const files = fs.readdirSync(root, { recursive: true })
      .map(String).filter((name) => name.endsWith(".jsonl"));
    const file = path.join(root, files[0]!);
    const unsafe = JSON.parse(JSON.stringify(base)) as { interaction: Record<string, unknown> };
    unsafe.interaction.content = { name: "敏感值" };
    fs.appendFileSync(file, `${JSON.stringify({ version: 1, item: unsafe })}\n`, "utf-8");
    expect(store.read("project", "sid-1")).toEqual([base]);

    store.append("project", "sid-1", {
      ...base,
      interaction: { ...base.interaction!, elicitationComplete: true },
    });
    expect(store.read("project", "sid-1")[0]?.interaction?.elicitationComplete).toBe(true);
  });

  it("恢复 UserDialog 原文和真实选择，丢弃非法嵌套结构及跨类型结果", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-interactions-"));
    const store = new InteractionStore(root);
    const base: TimelineItem = {
      id: "interaction-dialog-1", createdAt: 1, role: "tool", text: "",
      interaction: {
        requestId: "dialog-1", kind: "user_dialog", outcome: "answered", resolvedAt: 2,
        decider: "user", userDialogAction: "retry_fallback",
        userDialog: {
          dialogKind: "refusal_fallback_prompt", originalModel: "opus", fallbackModel: "sonnet",
          guidanceText: "可换模型重试", retractedMessageUuids: [],
        },
      },
    };
    store.append("project", "sid-1", base);
    expect(store.read("project", "sid-1")).toEqual([base]);

    const files = fs.readdirSync(root, { recursive: true })
      .map(String).filter((name) => name.endsWith(".jsonl"));
    const file = path.join(root, files[0]!);
    const wrongAction = JSON.parse(JSON.stringify(base)) as { interaction: Record<string, unknown> };
    wrongAction.interaction.userDialogAction = "continue";
    fs.appendFileSync(file, `${JSON.stringify({ version: 1, item: wrongAction })}\n`, "utf-8");
    expect(store.read("project", "sid-1")).toEqual([base]);

    const auto: TimelineItem = {
      id: "interaction-dialog-2", createdAt: 3, role: "tool", text: "",
      interaction: {
        requestId: "dialog-2", kind: "user_dialog", outcome: "answered", resolvedAt: 4,
        userDialogAction: "continue",
        userDialog: {
          dialogKind: "auto_mode_server_fallback", title: "自动模式", paragraphs: ["完整说明"],
          helpUrl: "https://example.com/help",
        },
      },
    };
    store.append("project", "sid-1", auto);
    expect(store.read("project", "sid-1")).toEqual([base, auto]);
    const malformed = JSON.parse(JSON.stringify(auto)) as { interaction: { userDialog: Record<string, unknown> } };
    malformed.interaction.userDialog.paragraphs = [1];
    fs.appendFileSync(file, `${JSON.stringify({ version: 1, item: malformed })}\n`, "utf-8");
    expect(store.read("project", "sid-1")).toEqual([base, auto]);
  });

  it("跳过坏行和不符合协议的条目，合法记录仍可恢复", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-interactions-"));
    const store = new InteractionStore(root);
    store.append("project", "sid-1", status("ok-1", "合法记录", 1));
    const files = fs.readdirSync(root, { recursive: true })
      .map(String).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const file = path.join(root, files[0]!);
    fs.appendFileSync(file, `${JSON.stringify({ version: 1, item: { id: 3, text: null } })}\nbad line\n`, "utf-8");
    expect(store.read("project", "sid-1")).toEqual([status("ok-1", "合法记录", 1)]);
    expect(store.read("project", "../escape")).toEqual([]);
  });
});
