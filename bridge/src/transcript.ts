import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HistoryMessage } from "./protocol";

/**
 * Claude 项目转录根目录。测试可用 CCC_FAKE_HOME 环境变量替换 home。
 * @returns ~/.claude/projects 绝对路径
 */
function projectsDir(): string {
  const home = process.env.CCC_FAKE_HOME ?? os.homedir();
  return path.join(home, ".claude", "projects");
}

/**
 * cwd → Claude 项目目录名。规则：非 [a-zA-Z0-9-] 字符替换为 '-'（下划线也替换）。
 * 例：D:\SVN_Cursor\chromeClaudeCode → D--SVN-Cursor-chromeClaudeCode（以真实目录名为准）
 * @param p 目录路径
 * @returns 目录名
 */
export function slugifyPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** 桥接消息包装中的用户问题标记（对应扩展端 composeMessage 的输出格式） */
const USER_QUESTION_MARK = "[用户问题]\n";

/**
 * 剥离桥接发送包装（防注入前缀、[页面上下文]/[选中文字] 块），只留真实用户输入。
 * 保证重载后回放历史的显示与当前会话气泡一致（气泡只显示用户输入部分）。
 * @param text jsonl 里的原始用户消息文本
 * @returns 用户实际输入；无标记（非桥接来源的消息）时原样返回
 */
function stripBridgeWrapper(text: string): string {
  const i = text.indexOf(USER_QUESTION_MARK);
  return i >= 0 ? text.slice(i + USER_QUESTION_MARK.length) : text;
}

/**
 * 读取某 session 的转录，抽取 user/assistant 纯文本消息（跳过工具块），取最后 max 条。
 * 用户消息先剥离桥接发送包装，避免重载回放后气泡里冒出页面上下文原文。
 * @param cwd 会话工作目录
 * @param sessionId 会话 ID
 * @param max 最多返回条数，默认 100
 * @returns 历史消息列表；文件不存在返回空数组
 */
export function readTranscript(cwd: string, sessionId: string, max = 100): HistoryMessage[] {
  const file = path.join(projectsDir(), slugifyPath(path.resolve(cwd)), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const out: HistoryMessage[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== "user" && e.type !== "assistant") continue;
      const content = e.message?.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((b: { type?: string }) => b?.type === "text")
          .map((b: { text?: string }) => b.text ?? "")
          .join("\n");
      }
      if (e.type === "user") text = stripBridgeWrapper(text); // 回放显示行为与当前会话一致
      if (text) out.push({ role: e.type, text: text.slice(0, 2000) });
    } catch {
      // 跳过坏行
    }
  }
  return out.slice(-max);
}
