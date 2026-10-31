/** CLI 转录无法可靠恢复的时间线事实侧车；版本化 UTF-8 JSONL，按文件夹和会话隔离。 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InteractionRecord, TimelineItem } from "./protocol";

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const OUTCOMES = new Set(["answered", "allowed", "denied", "cancelled", "timeout", "error"]);
const DECIDERS = new Set(["user", "timeout", "abort", "close", "system"]);

/** 判断值是否为非数组对象。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 可选字段出现时必须是字符串。 */
function optionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

/** 校验 MCP 请求结构；持久记录只允许字段名和安全 URL，不能携带表单 content。 */
function isElicitation(value: unknown): boolean {
  if (!isObject(value) || typeof value.serverName !== "string" || typeof value.message !== "string"
    || !["form", "url"].includes(String(value.mode))
    || !optionalStrings(value, ["url", "elicitationId", "title", "displayName", "description"])) return false;
  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields)) return false;
    for (const field of value.fields) {
      if (!isObject(field) || typeof field.name !== "string" || typeof field.title !== "string"
        || typeof field.required !== "boolean" || !["string", "number", "integer", "boolean"].includes(String(field.type))
        || !optionalStrings(field, ["description"])) return false;
      if (field.enum !== undefined && (!Array.isArray(field.enum)
        || !field.enum.every((option) => typeof option === "string"))) return false;
      if (field.default !== undefined && typeof field.default !== "string"
        && typeof field.default !== "number" && typeof field.default !== "boolean") return false;
    }
  }
  return true;
}

/** 校验 CLI 自有对话框的可渲染结构和原文，不接受其它未知 kind。 */
function isUserDialog(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.dialogKind === "refusal_fallback_prompt") {
    return typeof value.originalModel === "string" && typeof value.fallbackModel === "string"
      && optionalStrings(value, ["apiRefusalCategory", "guidanceText"])
      && (value.retractedMessageUuids === undefined || (Array.isArray(value.retractedMessageUuids)
        && value.retractedMessageUuids.every((id) => typeof id === "string")));
  }
  if (value.dialogKind === "auto_mode_server_fallback") {
    return typeof value.title === "string" && typeof value.helpUrl === "string"
      && optionalStrings(value, ["gatewayHost"])
      && Array.isArray(value.paragraphs) && value.paragraphs.every((text) => typeof text === "string");
  }
  return false;
}

/** 校验交互记录的必要字段及会直接进入 React 渲染的嵌套值。 */
function isInteraction(value: unknown): value is InteractionRecord {
  if (!isObject(value) || typeof value.requestId !== "string" || typeof value.resolvedAt !== "number") return false;
  if (!["ask", "permission", "exit_plan", "elicitation", "user_dialog"].includes(String(value.kind)) || !OUTCOMES.has(String(value.outcome))) return false;
  if (value.content !== undefined) return false; // 敏感表单值不属于 InteractionRecord，更不能从坏行恢复。
  if (value.elicitationAction !== undefined && !["accept", "decline", "cancel"].includes(String(value.elicitationAction))) return false;
  if (value.userDialogAction !== undefined && !["retry_fallback", "edit_prompt", "continue", "interrupt", "cancelled"]
    .includes(String(value.userDialogAction))) return false;
  if (value.userDialog !== undefined && !isUserDialog(value.userDialog)) return false;
  if (value.kind === "user_dialog") {
    if (!isUserDialog(value.userDialog)) return false;
    const dialog = value.userDialog as Record<string, unknown>;
    if (value.userDialogAction !== undefined) {
      const valid = dialog.dialogKind === "refusal_fallback_prompt"
        ? ["retry_fallback", "edit_prompt", "cancelled"].includes(String(value.userDialogAction))
        : ["continue", "interrupt", "cancelled"].includes(String(value.userDialogAction));
      if (!valid) return false;
    }
  }
  if (value.elicitationComplete !== undefined && typeof value.elicitationComplete !== "boolean") return false;
  if (value.submittedFields !== undefined && (!Array.isArray(value.submittedFields)
    || !value.submittedFields.every((field) => typeof field === "string"))) return false;
  if (value.elicitation !== undefined && !isElicitation(value.elicitation)) return false;
  if (!optionalStrings(value, ["tool", "toolUseId", "summary", "detail", "plan", "planFilePath", "feedback"])) return false;
  if (value.decider !== undefined && !DECIDERS.has(String(value.decider))) return false;
  if (value.answers !== undefined && (!isObject(value.answers) || !Object.values(value.answers).every((answer) => typeof answer === "string"))) return false;
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions)) return false;
    for (const question of value.questions) {
      if (!isObject(question) || typeof question.question !== "string" || typeof question.header !== "string"
        || typeof question.multiSelect !== "boolean" || !Array.isArray(question.options)) return false;
      if (!question.options.every((option) => isObject(option) && typeof option.label === "string"
        && optionalStrings(option, ["description", "preview"]))) return false;
    }
  }
  return true;
}

/** 校验侧车时间线项；坏行不得让整个历史回放失败。 */
function isTimelineItem(value: unknown): value is TimelineItem {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.text !== "string"
    || !Number.isFinite(value.createdAt) || !["user", "assistant", "tool"].includes(String(value.role))) return false;
  if (!optionalStrings(value, ["toolName", "sentText", "toolUseId", "toolInput", "toolOutput", "detail"])) return false;
  if (value.attachKind !== undefined && !["full", "selection", "upload"].includes(String(value.attachKind))) return false;
  if (value.toolStatus !== undefined && !["running", "success", "error", "unknown"].includes(String(value.toolStatus))) return false;
  return value.interaction === undefined || isInteraction(value.interaction);
}

interface SidecarEntry {
  version: 1;
  item: TimelineItem;
}

export class InteractionStore {
  /** @param rootDir 侧车根目录，通常位于 CCC_BRIDGE_HOME 下 */
  constructor(private readonly rootDir: string) {}

  /** 返回文件夹哈希目录中的会话文件；非法会话 ID 不生成路径。 */
  private filePath(folder: string, sessionId: string): string | null {
    if (!SAFE_SESSION_ID.test(sessionId)) return null;
    const folderKey = createHash("sha256").update(path.resolve(folder)).digest("hex").slice(0, 32);
    return path.join(this.rootDir, folderKey, `${sessionId}.jsonl`);
  }

  /**
   * 追加一个时间线事实的新版本；读取时按稳定 ID 合并。
   * @param folder 会话工作目录
   * @param sessionId CLI 会话 ID
   * @param item 需要持久化的状态或人工裁决，不保存敏感 elicitation 值
   * @returns 无；非法会话 ID 静默忽略
   * @throws 文件系统不可写时由调用方决定是否降级
   */
  append(folder: string, sessionId: string, item: TimelineItem): void {
    const file = this.filePath(folder, sessionId);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry: SidecarEntry = { version: 1, item };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
  }

  /**
   * 读取并合并一个会话的侧车；Map 保留首次出现顺序，set 更新同一 ID 的内容。
   * @param folder 会话工作目录
   * @param sessionId CLI 会话 ID
   * @returns 合法时间线事实；文件不存在、损坏或 ID 非法时返回可用部分/空数组
   */
  read(folder: string, sessionId: string): TimelineItem[] {
    const file = this.filePath(folder, sessionId);
    if (!file || !fs.existsSync(file)) return [];
    const items = new Map<string, TimelineItem>();
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Partial<SidecarEntry>;
        if (entry.version === 1 && isTimelineItem(entry.item)) items.set(entry.item.id, entry.item);
      } catch {
        // 单行损坏不阻断其它事实恢复。
      }
    }
    return [...items.values()];
  }

  /** 删除会话时同步删除对应侧车；目标不存在视为已完成。 */
  delete(folder: string, sessionId: string): void {
    const file = this.filePath(folder, sessionId);
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  }
}
