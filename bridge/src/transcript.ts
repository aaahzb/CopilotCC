import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HistoryMessage, SessionInfo } from "./protocol";
import { GUARD_PREFIX } from "./claude-session";

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
 * 拆解桥接发送包装的用户消息：显示文本只留真实输入，完整发送内容保留到 sentText 供右键溯源。
 * 防注入前缀（仅新会话首条）从 sentText 去掉，与当前会话气泡的 sentText 口径（composeMessage 输出）一致。
 * @param raw jsonl 里的原始用户消息文本
 * @returns text 为用户实际输入；sentText/attachKind 仅桥接包装消息有；无标记消息只返回 text
 */
function parseUserText(raw: string): { text: string; sentText?: string; attachKind?: "full" | "selection" } {
  const sent = raw.startsWith(GUARD_PREFIX) ? raw.slice(GUARD_PREFIX.length) : raw;
  const i = sent.indexOf(USER_QUESTION_MARK);
  if (i < 0) return { text: sent }; // 非桥接来源（如交互式 CLI 手动发的消息）
  const head = sent.slice(0, i); // 包装部分：[页面上下文]/[选中文字] 块；无附带时为空
  const text = sent.slice(i + USER_QUESTION_MARK.length);
  const attachKind: "full" | "selection" | undefined = head.includes("[页面上下文")
    ? "full"
    : head.includes("[选中文字]")
      ? "selection"
      : undefined;
  return { text, sentText: sent, ...(attachKind ? { attachKind } : {}) };
}

/**
 * 读取某 session 的转录，抽取 user/assistant 纯文本消息（跳过工具块），取最后 max 条。
 * 桥接来源的用户消息拆成 text（问题）+ sentText（完整发送内容）+ attachKind（附带标记），
 * 保证重载回放的显示与溯源行为和当前会话气泡一致。
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
      if (e.type === "user") {
        const p = parseUserText(text); // 拆包装：显示与溯源口径同当前会话
        if (p.text) {
          out.push({
            role: "user",
            text: p.text.slice(0, 2000),
            ...(p.sentText ? { sentText: p.sentText } : {}),
            ...(p.attachKind ? { attachKind: p.attachKind } : {}),
          });
        }
      } else if (text) {
        out.push({ role: e.type, text: text.slice(0, 2000) });
      }
    } catch {
      // 跳过坏行
    }
  }
  return out.slice(-max);
}

/** 会话 ID 安全字符：防路径穿越，只允许字母数字、连字符、下划线 */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * 枚举某文件夹工作目录下的全部 Claude 会话（扫描 ~/.claude/projects/<slug>/*.jsonl）。
 * 标题取首条用户消息拆解包装后的前 30 字；按转录文件 mtime 倒序（最近活跃在前）。
 * @param cwd 会话工作目录
 * @returns 会话列表；目录不存在返回空数组
 */
export function listSessions(cwd: string): SessionInfo[] {
  const dir = path.join(projectsDir(), slugifyPath(path.resolve(cwd)));
  if (!fs.existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!SAFE_SESSION_ID.test(sessionId)) continue; // 跳过非会话文件与可疑名字
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      let title = "";
      // 只读文件头 64KB 找首条用户文本消息，避免整读大转录
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.subarray(0, n).toString("utf-8").split("\n")) {
        if (!line.includes('"user"')) continue; // 粗筛，减少 JSON.parse 次数
        try {
          const e = JSON.parse(line);
          if (e.type !== "user") continue;
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
          const p = parseUserText(text); // 拆桥接包装，标题只留真实问题
          const t = p.text.replace(/\s+/g, " ").trim();
          if (t) {
            title = t.slice(0, 30);
            break;
          }
        } catch {
          // 跳过坏行
        }
      }
      out.push({ sessionId, title: title || "(空会话)", updatedAt: Math.round(st.mtimeMs) });
    } catch {
      // 跳过不可读文件
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * 删除会话转录文件。sessionId 先做安全字符校验防路径穿越。
 * @param cwd 会话工作目录
 * @param sessionId 会话 ID
 * @returns 是否真的删除了文件（不存在或 ID 非法返回 false）
 */
export function deleteTranscript(cwd: string, sessionId: string): boolean {
  if (!SAFE_SESSION_ID.test(sessionId)) return false;
  const file = path.join(projectsDir(), slugifyPath(path.resolve(cwd)), `${sessionId}.jsonl`);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
