import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EffortLevelSetting, HistoryMessage, SessionInfo, AskQuestion, InteractionRecord, TimelineItem } from "./protocol";
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
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptEntry {
  type: "user" | "assistant" | "system";
  subtype?: string;
  /** compact_boundary 条目的压缩元数据（字段名与转录一致，非 stream-json 的 snake_case） */
  compactMetadata?: { preTokens?: number; postTokens?: number; preservedSegment?: { anchorUuid?: string } };
  uuid?: string;
  parentUuid?: string;
  isMeta?: boolean;
  /** CLI 自动压缩生成的内部上下文摘要，不是用户亲手发送的消息 */
  isCompactSummary?: boolean;
  /** 异步 Task 通知的 CLI 内部来源标记；不能仅凭用户文本中的相似 XML 判断 */
  turnOrigin?: string;
  origin?: { kind?: string };
  message?: { content?: string | TranscriptBlock[] };
  /** 历史字段名（实时 SDK 为 tool_use_result）；Ask 在这里保存实际 answers */
  toolUseResult?: unknown;
  timestamp?: string;
}

/**
 * 历史压缩记录行文案：与扩展 compactRecordText 成功分支同口径（桥接端独立实现，避免跨端引用）。
 * @param meta compact_boundary 的 compactMetadata；缺元数据时退化为简单文案
 * @returns 🗜 记录行文本；负压缩率省略百分比
 */
export function compactBoundaryText(meta: { preTokens?: number; postTokens?: number } | undefined): string {
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

/** 识别 CLI 自己写入的异步任务通知，不信任用户可手输的 XML 外观。 */
function isTaskNotification(entry: TranscriptEntry): boolean {
  return entry.turnOrigin === "task_notification" || entry.origin?.kind === "task-notification";
}

/**
 * 将异步 task-notification 恢复为短状态 + 折叠报告。
 * @param entry 带 CLI 内部来源标记的转录记录
 * @returns taskId 供实时/历史按同一 ID 合并；非任务通知返回 null
 */
function parseTaskNotification(entry: TranscriptEntry): { taskId?: string; message: HistoryMessage } | null {
  if (!isTaskNotification(entry)) return null;
  const text = transcriptText(entry);
  const taskId = localTagText(text, "task-id");
  const status = localTagText(text, "status");
  const summary = localTagText(text, "summary");
  const outputFile = localTagText(text, "output-file");
  const usage = localTagText(text, "usage");
  const report = localTagText(text, "result");
  const metadata = {
    ...(status !== null ? { status } : {}),
    ...(summary !== null ? { summary } : {}),
    ...(outputFile !== null ? { output_file: outputFile } : {}),
    ...(usage !== null ? { usage } : {}),
  };
  const metadataText = Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : "";
  // 未识别的新结构也把原始通知留在折叠详情，不能静默丢弃。
  const detail = [report ?? (metadataText ? "" : text), metadataText].filter(Boolean).join("\n\n");
  const state = status === "completed" ? "已完成" : status === "failed" ? "失败" : status ? "已停止" : "通知";
  return {
    ...(taskId ? { taskId } : {}),
    message: {
      role: "tool",
      text: taskId ? `任务${state}：${taskId}` : "任务通知",
      ...(detail ? { detail } : {}),
    },
  };
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

/** 将转录中的结构化补丁追加到普通结果文本，历史回放与实时显示同一份完整 diff。 */
function appendStructuredPatch(output: string, fallback: unknown): string {
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return output;
  const patches = (fallback as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(patches)) return output;
  const lines = patches.flatMap((patch) => {
    if (!patch || typeof patch !== "object") return [];
    const p = patch as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown };
    if (![p.oldStart, p.oldLines, p.newStart, p.newLines].every((value) => typeof value === "number") || !Array.isArray(p.lines)) return [];
    return [
      `@@ -${p.oldStart},${p.oldLines} +${p.newStart},${p.newLines} @@`,
      ...p.lines.filter((line): line is string => typeof line === "string"),
    ];
  });
  return lines.length > 0 ? [output, lines.join("\n")].filter(Boolean).join("\n\n") : output;
}

/**
 * 将转录 tool_result 内容转为完整文本；结构化内容使用缩进 JSON，不做长度截断。
 * @param content tool_result.content
 * @param fallback 同条 user 记录的 toolUseResult；补充 structuredPatch，无内容时作为完整回退
 * @returns 完整输出文本
 */
function transcriptResultText(content: unknown, fallback: unknown): string {
  if (content === undefined || content === null) {
    if (typeof fallback === "string") return fallback;
    return fallback === undefined || fallback === null ? "" : JSON.stringify(fallback, null, 2);
  }
  const output = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return JSON.stringify(block, null, 2);
    }).filter(Boolean).join("\n")
      : JSON.stringify(content, null, 2);
  return appendStructuredPatch(output, fallback);
}

/**
 * 按 tool_use_id 配对普通工具结果；调用和结果即使跨记录也能合并。
 * @param entries 按转录顺序排列的记录
 * @returns 调用 ID 到完整输出与错误标记的映射
 */
function findToolResults(entries: TranscriptEntry[]): Map<string, { output: string; isError: boolean; structured: unknown; resolvedAt: number }> {
  const results = new Map<string, { output: string; isError: boolean; structured: unknown; resolvedAt: number }>();
  for (const entry of entries) {
    if (entry.type !== "user" || !Array.isArray(entry.message?.content)) continue;
    const parsedTime = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    for (const block of entry.message.content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      results.set(block.tool_use_id, {
        output: transcriptResultText(block.content, entry.toolUseResult),
        isError: block.is_error === true,
        structured: entry.toolUseResult,
        resolvedAt: Number.isFinite(parsedTime) ? parsedTime : 0,
      });
    }
  }
  return results;
}

/**
 * 按 tool_use_id 收集 AskUserQuestion 的真实作答结果；相同问题文本不会互相串答。
 * @param entries 按转录顺序排列的记录
 * @returns 工具调用 ID 到 questions/answers/作答时间的映射
 */
function findAskResults(entries: TranscriptEntry[]): Map<string, { questions?: AskQuestion[]; answers: Record<string, string>; resolvedAt: number }> {
  const results = new Map<string, { questions?: AskQuestion[]; answers: Record<string, string>; resolvedAt: number }>();
  for (const entry of entries) {
    if (entry.type !== "user" || !entry.toolUseResult || typeof entry.toolUseResult !== "object" || Array.isArray(entry.toolUseResult)) continue;
    const result = entry.toolUseResult as { questions?: unknown; answers?: unknown };
    if (!result.answers || typeof result.answers !== "object" || Array.isArray(result.answers)) continue;
    const answers: Record<string, string> = {};
    for (const [question, answer] of Object.entries(result.answers)) {
      if (typeof answer === "string") answers[question] = answer;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const parsedTime = entry.timestamp ? Date.parse(entry.timestamp) : 0;
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      results.set(block.tool_use_id, {
        ...(Array.isArray(result.questions) ? { questions: result.questions as AskQuestion[] } : {}),
        answers,
        resolvedAt: Number.isFinite(parsedTime) ? parsedTime : 0,
      });
    }
  }
  return results;
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
function readTranscriptTimeline(cwd: string, sessionId: string): TimelineItem[] {
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

  const askResults = findAskResults(entries);
  const toolResults = findToolResults(entries);
  const { activities, consumed } = findLocalCommands(entries);
  // boundary.preservedSegment.anchorUuid 精确指向本次摘要；只关联 CLI 标记的内部摘要。
  const compactSummaries = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "user" && entry.isCompactSummary === true && typeof entry.uuid === "string") {
      const summary = transcriptText(entry);
      if (summary) compactSummaries.set(entry.uuid, summary);
    }
  }
  const out: TimelineItem[] = [];
  const append = (message: HistoryMessage, id: string, createdAt: number): void => {
    out.push({ ...message, id: `history-${id}`, createdAt });
  };
  for (const [entryIndex, e] of entries.entries()) {
    const entryId = typeof e.uuid === "string" ? e.uuid : `line-${entryIndex + 1}`;
    const parsedTime = e.timestamp ? Date.parse(e.timestamp) : 0;
    const createdAt = Number.isFinite(parsedTime) ? parsedTime : 0;
    if (e.type === "system") {
      const anchorUuid = e.compactMetadata?.preservedSegment?.anchorUuid;
      const summary = anchorUuid ? compactSummaries.get(anchorUuid) : undefined;
      append({
        role: "tool", text: compactBoundaryText(e.compactMetadata),
        ...(summary ? { detail: summary } : {}),
      }, `${entryId}-compact`, createdAt); // 摘要只作为本记录的折叠详情，不成为用户气泡
      continue;
    }
    if (typeof e.uuid === "string") {
      const activity = activities.get(e.uuid);
      if (activity) {
        append(activity, `${entryId}-local`, createdAt);
        continue;
      }
      if (consumed.has(e.uuid)) continue;
    }
    if (e.type === "user") {
      const task = parseTaskNotification(e);
      if (task) {
        // 实时通知使用 task-<id>；历史沿用该 ID，侧车合并和 chat.sync 才不会重复或变成用户气泡。
        out.push({
          ...task.message,
          id: task.taskId ? `task-${task.taskId}` : `history-${entryId}-task`,
          createdAt,
        });
        continue;
      }
      // isMeta/isCompactSummary 都是 CLI 注入的内部上下文，不是用户亲手发送的气泡。
      if (e.isMeta === true || e.isCompactSummary === true) continue;
      const p = parseUserText(transcriptText(e)); // 拆包装：显示与溯源口径同当前会话
      if (p.text) {
        append({
          role: "user",
          text: p.text,
          ...(p.sentText ? { sentText: p.sentText } : {}),
          ...(p.attachKind ? { attachKind: p.attachKind } : {}),
        }, `${entryId}-user`, createdAt);
      }
      continue;
    }

    const content = e.message?.content;
    if (typeof content === "string") {
      if (content) append({ role: "assistant", text: content }, `${entryId}-assistant`, createdAt);
      continue;
    }
    if (!Array.isArray(content)) continue;
    let textParts: string[] = [];
    let textSegment = 0;
    const flushText = (): void => {
      const text = textParts.join("\n");
      if (text) append({ role: "assistant", text }, `${entryId}-text-${textSegment++}`, createdAt);
      textParts = [];
    };
    for (const [blockIndex, b] of content.entries()) {
      if (b?.type === "text") {
        textParts.push(b.text ?? "");
      } else if (b?.type === "tool_use") {
        flushText(); // 工具与正文严格按 content 原始顺序回放；提问只由专用记录展示
        if (b.name === "AskUserQuestion") {
          const result = typeof b.id === "string" ? askResults.get(b.id) : undefined;
          if (result && typeof b.id === "string") {
            const inputQuestions = Array.isArray(b.input?.questions) ? b.input.questions as AskQuestion[] : [];
            const interaction: InteractionRecord = {
              requestId: `history-${b.id}`,
              kind: "ask",
              tool: "AskUserQuestion",
              toolUseId: b.id,
              questions: result.questions ?? inputQuestions,
              answers: result.answers,
              outcome: "answered",
              resolvedAt: result.resolvedAt,
              decider: "user",
            };
            append({ role: "tool", toolName: "AskUserQuestion", text: "已回答", toolUseId: b.id, interaction }, `${entryId}-tool-${blockIndex}`, createdAt);
          }
        } else if (b.name === "ExitPlanMode") {
          const result = typeof b.id === "string" ? toolResults.get(b.id) : undefined;
          if (result && typeof b.id === "string") {
            const structured = result.structured && typeof result.structured === "object" && !Array.isArray(result.structured)
              ? result.structured as { plan?: unknown; filePath?: unknown }
              : {};
            const plan = typeof b.input?.plan === "string" ? b.input.plan
              : typeof structured.plan === "string" ? structured.plan : undefined;
            const planFilePath = typeof b.input?.planFilePath === "string" ? b.input.planFilePath
              : typeof structured.filePath === "string" ? structured.filePath : undefined;
            const interaction: InteractionRecord = {
              requestId: `history-${b.id}`,
              kind: "exit_plan",
              tool: "ExitPlanMode",
              toolUseId: b.id,
              summary: "申请批准计划并继续执行",
              detail: JSON.stringify(b.input ?? {}, null, 2),
              ...(plan !== undefined ? { plan } : {}),
              ...(planFilePath ? { planFilePath } : {}),
              ...(result.isError && result.output ? { feedback: result.output } : {}),
              outcome: result.isError ? "denied" : "allowed",
              resolvedAt: result.resolvedAt,
              decider: "user",
            };
            append({
              role: "tool", toolName: "ExitPlanMode", text: result.isError ? "已退回" : "已批准",
              toolUseId: b.id, interaction,
            }, `${entryId}-tool-${blockIndex}`, createdAt);
          }
        } else {
          const result = typeof b.id === "string" ? toolResults.get(b.id) : undefined;
          append({
            role: "tool",
            toolName: b.name ?? "tool",
            text: summarizeTool(b),
            ...(b.id ? {
              toolUseId: b.id,
              toolStatus: result ? (result.isError ? "error" as const : "success" as const) : "unknown" as const,
              toolInput: JSON.stringify(b.input ?? {}, null, 2),
              ...(result ? { toolOutput: result.output } : {}),
            } : {}),
          }, `${entryId}-tool-${blockIndex}`, createdAt);
        }
      }
    }
    flushText();
  }
  return out;
}

/**
 * 读取转录末尾消息，保留旧调用的无 ID 返回形状。
 * @param cwd 会话工作目录
 * @param sessionId 会话 ID
 * @param max 最多返回条数
 * @returns 末尾历史消息
 */
export function readTranscript(cwd: string, sessionId: string, max = 100): HistoryMessage[] {
  return readTranscriptTimeline(cwd, sessionId).slice(-max).map(({ id: _id, createdAt: _createdAt, ...message }) => message);
}

export interface TranscriptPage {
  messages: TimelineItem[];
  hasMore: boolean;
  /** 仍有更早记录时，取本页首项 ID 作为下一次 before */
  nextCursor?: string;
}

/** 同一压缩的转录行与实时侧车使用不同 ID；仅在一秒事件窗口内合并同文案的一对记录。 */
function isLiveCompactDuplicate(transcript: TimelineItem, live: TimelineItem): boolean {
  return transcript.id.startsWith("history-") && transcript.id.endsWith("-compact")
    && live.id.startsWith("status-")
    && transcript.role === "tool" && live.role === "tool"
    && live.text.startsWith("🗜 已压缩上下文") && live.text === transcript.text
    && live.createdAt >= transcript.createdAt
    && live.createdAt - transcript.createdAt <= 1000;
}

/** 侧车补充同一事实的新版本；工具执行与交互决定是两类事实，同 toolUseId 也必须各占一行。 */
function mergeTimelineItems(base: TimelineItem[], additional: TimelineItem[]): TimelineItem[] {
  const all = [...base];
  for (const extra of additional) {
    const index = all.findIndex((item) => item.id === extra.id || isLiveCompactDuplicate(item, extra) || Boolean(
      extra.toolUseId && item.toolUseId === extra.toolUseId && Boolean(item.interaction) === Boolean(extra.interaction),
    ));
    if (index < 0) {
      all.push(extra);
      continue;
    }
    const previous = all[index]!;
    all[index] = {
      ...previous,
      ...extra,
      ...(previous.interaction && extra.interaction
        ? { interaction: { ...previous.interaction, ...extra.interaction } }
        : {}),
    };
  }
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

/** 旧版侧车曾把完整 Task 报告写进正文；读取时迁移，不改写用户的原始历史文件。 */
function normalizeLegacyTask(item: TimelineItem): TimelineItem {
  if (item.role !== "tool" || !item.id.startsWith("task-")) return item;
  const match = /^任务(已完成|失败|已停止)：([\s\S]*)$/.exec(item.text);
  const report = match?.[2] ?? "";
  if (!match || (report.length <= 160 && !/[\r\n]/.test(report))) return item;
  const detail = [report, item.detail].filter(Boolean).join("\n\n");
  return { ...item, text: `任务${match[1]}：${item.id.slice("task-".length)}`, detail };
}

/**
 * 以本页首项稳定 ID 为游标读取更早历史；追加新转录不会让已读项重复或串页。
 * @param cwd 会话工作目录
 * @param sessionId 会话 ID
 * @param options.limit 每页条数，限制在 1-200
 * @param options.before 只返回该稳定 ID 之前的项目；缺省取最新一页
 * @param options.additional CLI 未落盘的侧车事实，合并后统一分页
 * @returns 按原顺序排列的一页及更早记录游标
 */
export function readTranscriptPage(
  cwd: string,
  sessionId: string,
  options: { limit?: number; before?: string; additional?: TimelineItem[] } = {},
): TranscriptPage {
  const all = mergeTimelineItems(readTranscriptTimeline(cwd, sessionId), options.additional ?? []).map(normalizeLegacyTask);
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
  const cursorIndex = options.before === undefined ? all.length : all.findIndex((item) => item.id === options.before);
  // 失效游标不冒充最新页：返回空页，调用方可重新从最新快照恢复。
  if (cursorIndex < 0) return { messages: [], hasMore: false };
  const start = Math.max(0, cursorIndex - limit);
  const messages = all.slice(start, cursorIndex);
  return {
    messages,
    hasMore: start > 0,
    ...(start > 0 && messages[0] ? { nextCursor: messages[0].id } : {}),
  };
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
          if (e.type !== "user" || e.isCompactSummary === true || isTaskNotification(e)) continue;
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
