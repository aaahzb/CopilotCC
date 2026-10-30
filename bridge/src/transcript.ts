import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EffortLevelSetting, HistoryMessage, SessionInfo } from "./protocol";
import { GUARD_PREFIX, summarizeTool } from "./claude-session";

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
function parseUserText(raw: string): { text: string; sentText?: string; attachKind?: "full" | "selection" | "upload" } {
  const sent = raw.startsWith(GUARD_PREFIX) ? raw.slice(GUARD_PREFIX.length) : raw;
  const i = sent.indexOf(USER_QUESTION_MARK);
  if (i < 0) return { text: sent }; // 非桥接来源（如交互式 CLI 手动发的消息）
  const head = sent.slice(0, i); // 包装部分：[上传文件]/[页面上下文]/[选中文字] 块；无附带时为空
  const text = sent.slice(i + USER_QUESTION_MARK.length);
  // 一条消息可能同时带页面与上传文件：标记优先取 upload（文件是本轮最显眼的附带物）
  const attachKind: "full" | "selection" | "upload" | undefined = head.includes("[上传文件]")
    ? "upload"
    : head.includes("[页面上下文")
      ? "full"
      : head.includes("[选中文字]")
        ? "selection"
        : undefined;
  return { text, sentText: sent, ...(attachKind ? { attachKind } : {}) };
}

interface TranscriptBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TranscriptEntry {
  type: "user" | "assistant" | "system";
  subtype?: string;
  /** compact_boundary 条目的压缩元数据（字段名与转录一致，非 stream-json 的 snake_case） */
  compactMetadata?: { preTokens?: number; postTokens?: number };
  uuid?: string;
  parentUuid?: string;
  isMeta?: boolean;
  message?: { content?: string | TranscriptBlock[] };
}

/**
 * 历史压缩记录行文案：与扩展 compactRecordText 成功分支同口径（桥接端独立实现，避免跨端引用）。
 * @param meta compact_boundary 的 compactMetadata；缺元数据时退化为简单文案
 * @returns 🗜 记录行文本；负压缩率省略百分比
 */
function compactBoundaryText(meta: { preTokens?: number; postTokens?: number } | undefined): string {
  if (meta?.preTokens === undefined || meta.postTokens === undefined) return "🗜 已压缩上下文";
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const pct = meta.preTokens > 0 ? Math.max(0, Math.round((1 - meta.postTokens / meta.preTokens) * 100)) : 0;
  return `🗜 已压缩上下文 ${k(meta.preTokens)} → ${k(meta.postTokens)} tokens${pct > 0 ? `（-${pct}%）` : ""}`;
}

/**
 * 提取一条转录记录的纯文本；数组内容只拼接文本块，工具块由调用方单独处理。
 * @param entry 已限定为 user/assistant 的转录记录
 * @returns 字符串内容或文本块拼接结果
 */
function transcriptText(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * 读取成对 XML 标签之间的文本。只用于已验证父链的本地命令，不做全局标签过滤。
 * @param text 原始消息文本
 * @param tag 不含尖括号的标签名
 * @returns 去除首尾空白的内容；标签不完整时返回 null
 */
function localTagText(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? null : text.slice(start + open.length, end).trim();
}

/**
 * 找出具有 caveat → command → stdout 真实父子关系的本地命令。
 * @param entries 按转录顺序排列的 user/assistant 记录
 * @returns command uuid 对应的活动消息，以及应被合并隐藏的原始记录 uuid
 */
function findLocalCommands(entries: TranscriptEntry[]): {
  activities: Map<string, HistoryMessage>;
  consumed: Set<string>;
} {
  const byId = new Map<string, TranscriptEntry>();
  const stdoutByParent = new Map<string, { id: string; text: string }>();
  for (const e of entries) {
    if (typeof e.uuid === "string") byId.set(e.uuid, e);
    if (e.type !== "user" || typeof e.uuid !== "string" || typeof e.parentUuid !== "string") continue;
    const stdout = localTagText(transcriptText(e), "local-command-stdout");
    if (stdout !== null && !stdoutByParent.has(e.parentUuid)) {
      stdoutByParent.set(e.parentUuid, { id: e.uuid, text: stdout });
    }
  }

  const activities = new Map<string, HistoryMessage>();
  const consumed = new Set<string>();
  for (const command of entries) {
    if (command.type !== "user" || typeof command.uuid !== "string" || typeof command.parentUuid !== "string") continue;
    const commandText = transcriptText(command);
    const name = localTagText(commandText, "command-name");
    if (!name) continue;
    const caveat = byId.get(command.parentUuid);
    const stdout = stdoutByParent.get(command.uuid);
    // 三重校验防止用户手动输入相似标签时被误吞：元数据 caveat、直接父链、直接 stdout 子记录缺一不可。
    if (caveat?.type !== "user" || caveat.isMeta !== true || caveat.uuid !== command.parentUuid) continue;
    if (localTagText(transcriptText(caveat), "local-command-caveat") === null || !stdout) continue;
    const args = localTagText(commandText, "command-args") ?? "";
    activities.set(command.uuid, {
      role: "tool",
      toolName: name,
      text: [args, stdout.text].filter(Boolean).join(" → "),
    });
    consumed.add(command.parentUuid).add(command.uuid).add(stdout.id);
  }
  return { activities, consumed };
}

/**
 * 读取某 session 的转录，按原顺序抽取用户正文、回答正文、工具活动和压缩记录行，取最后 max 条。
 * compact_boundary 条目回放为无 toolName 的 tool 行（🗜 文案），历史里也能看到压缩发生的位置。
 * 桥接来源的用户消息拆成 text（问题）+ sentText（完整发送内容）+ attachKind（附带标记）。
 * 本地命令只在真实父链完整时合并为活动，普通用户输入的相似标签仍按正文保留。
 * @param cwd 会话工作目录
 * @param sessionId 会话 ID
 * @param max 最多返回条数，默认 100
 * @returns 历史消息列表；文件不存在返回空数组
 */
export function readTranscript(cwd: string, sessionId: string, max = 100): HistoryMessage[] {
  const file = path.join(projectsDir(), slugifyPath(path.resolve(cwd)), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const entries: TranscriptEntry[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TranscriptEntry;
      if (e.type === "user" || e.type === "assistant") entries.push(e);
      else if (e.type === "system" && e.subtype === "compact_boundary") entries.push(e); // 压缩位置也要持久回放
    } catch {
      // 跳过坏行
    }
  }

  const { activities, consumed } = findLocalCommands(entries);
  const out: HistoryMessage[] = [];
  for (const e of entries) {
    if (e.type === "system") {
      out.push({ role: "tool", text: compactBoundaryText(e.compactMetadata) }); // 无 toolName：与实时压缩记录行同款纯文本卡片
      continue;
    }
    if (typeof e.uuid === "string") {
      const activity = activities.get(e.uuid);
      if (activity) {
        out.push(activity);
        continue;
      }
      if (consumed.has(e.uuid)) continue;
    }
    if (e.type === "user") {
      const p = parseUserText(transcriptText(e)); // 拆包装：显示与溯源口径同当前会话
      if (p.text) {
        out.push({
          role: "user",
          text: p.text.slice(0, 2000),
          ...(p.sentText ? { sentText: p.sentText } : {}),
          ...(p.attachKind ? { attachKind: p.attachKind } : {}),
        });
      }
      continue;
    }

    const content = e.message?.content;
    if (typeof content === "string") {
      if (content) out.push({ role: "assistant", text: content.slice(0, 2000) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    let textParts: string[] = [];
    const flushText = (): void => {
      const text = textParts.join("\n");
      if (text) out.push({ role: "assistant", text: text.slice(0, 2000) });
      textParts = [];
    };
    for (const b of content) {
      if (b?.type === "text") {
        textParts.push(b.text ?? "");
      } else if (b?.type === "tool_use") {
        flushText(); // 工具与正文严格按 content 原始顺序回放
        out.push({ role: "tool", toolName: b.name ?? "tool", text: summarizeTool(b) });
      }
    }
    flushText();
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
