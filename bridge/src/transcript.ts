import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EffortLevelSetting, HistoryMessage, SessionInfo } from "./protocol";
import { GUARD_PREFIX } from "./claude-session";

/**
 * Claude 项目转录根目录。测试可用 CCC_FAKE_HOME 环境变量替换 home。
 * CLAUDE_CONFIG_DIR 覆盖默认 ~/.claude（CLI 同一规则），自定义配置目录下转录随之迁移。
 * @returns ~/.claude/projects 绝对路径
 */
function projectsDir(): string {
  if (process.env.CCC_FAKE_HOME) return path.join(process.env.CCC_FAKE_HOME, ".claude", "projects");
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
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

/** 只读转录末尾窗口大小（最近一次 api-request-blob 必在末尾附近；8MB 足以覆盖巨型工具输出） */
const TAIL_BYTES = 8 * 1024 * 1024;

/**
 * 从转录文本提取最近一次 API 请求实际携带的 effort。
 * SDK 流不下发 effort（init/assistant/result 帧均无该字段，probe-frames 探针实证 CLI 2.1.301），
 * 但 CLI 会把每次请求参数以 api-request-blob 条目落盘 —— 最近一个 blob 即本轮回答的请求（每回答粒度）。
 * @param text 转录（或其尾部窗口）文本
 * @returns 五档值 = 最近请求实发 effort；null = 最近 blob 无 effort 字段（该会话不下发 effort 参数）；
 *          undefined = 窗口内无 api-request-blob（无证据，调用方不应覆盖已有值）
 */
export function extractEffortFromTranscript(text: string): EffortLevelSetting | null | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln.includes('"type":"api-request-blob"')) continue;
    const m = /"effort"\s*:\s*"(low|medium|high|xhigh|max)"/.exec(ln);
    return m ? (m[1] as EffortLevelSetting) : null;
  }
  return undefined;
}

/**
 * 读取会话转录末尾并提取最近一次请求的 effort（每回答一次；仅读末尾 8MB，同步 IO 毫秒级）。
 * @param cwd 会话工作目录（与 readTranscript 同一 slug 规则定位项目目录）
 * @param sessionId 会话 ID
 * @returns 同 extractEffortFromTranscript；任何 IO 失败返回 undefined（不阻断对话主流程）
 */
export function readTranscriptEffort(cwd: string, sessionId: string): EffortLevelSetting | null | undefined {
  if (!SAFE_SESSION_ID.test(sessionId)) return undefined; // 与 deleteTranscript 同一防穿越校验
  const file = path.join(projectsDir(), slugifyPath(path.resolve(cwd)), `${sessionId}.jsonl`);
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return extractEffortFromTranscript(buf.toString("utf-8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
