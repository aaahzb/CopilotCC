/**
 * WS 消息协议（单一来源）。修改本文件后运行 scripts/sync-protocol.mjs 同步到两端。
 * 消息命名：客户端 → 服务用动词（chat.send），服务 → 客户端用结果（chat.delta）。
 */

/** 权限模式设置：auto=自动审批分类器；approve-each=聊天内逐条审批卡片 */
export type PermissionModeSetting = "auto" | "acceptEdits" | "plan" | "approve-each";

/** 推理强度档位（对应 Agent SDK 的 EffortLevel） */
export type EffortLevelSetting = "low" | "medium" | "high" | "xhigh" | "max";

/** 历史回放消息 */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** 完整发送内容（已去防注入前缀）；仅桥接来源的用户消息有，供右键溯源 */
  sentText?: string;
  /** 附带标记：full=页面全文，selection=仅选中文字，upload=上传文件 */
  attachKind?: "full" | "selection" | "upload";
}

/** 会话列表项（一个文件夹下可有多个会话） */
export interface SessionInfo {
  sessionId: string;
  /** 标题：首条用户消息拆解包装后的前 30 字；无则 "(空会话)" */
  title: string;
  /** 转录文件 mtime，epoch 毫秒 */
  updatedAt: number;
}

/** 别名：文件夹+会话组合的命名快捷方式（桥接 aliases.json 持久化，扩展平时只显别名标签） */
export interface AliasInfo {
  id: string;
  name: string;
  folder: string;
  /** 绑定的会话 ID；null = 选中别名时在该文件夹开新会话 */
  sessionId: string | null;
  /** 页面信息丰富度（附带网页时注入正文的字符量档位）；未设置 = standard */
  pageRichness?: PageRichness;
}

/** 聊天随附的上传文件（base64 内容；桥接落盘到绑定文件夹的 copilotUploads 目录） */
export interface UploadFile {
  name: string;
  dataB64: string;
}

/** 单次上传文件数上限 */
export const MAX_UPLOAD_FILES = 10;
/** 单文件 base64 字符数上限（≈30MB 二进制） */
export const MAX_UPLOAD_B64_CHARS = 41_000_000;
/** 单次上传 base64 总字符数上限（≈45MB 二进制；ws 默认 100MiB 帧上限内留足余量） */
export const MAX_UPLOAD_TOTAL_B64 = 60_000_000;

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "client.ready" }
  | { type: "folder.bind"; path: string }
  | { type: "folder.pick" }
  | { type: "chat.send"; text: string; uploads?: UploadFile[] }
  | { type: "chat.abort" }
  | { type: "permission.response"; requestId: string; allow: boolean }
  | { type: "session.history" }
  | { type: "session.list" }
  | { type: "session.new" }
  | { type: "session.switch"; sessionId: string }
  | { type: "session.delete"; sessionId: string }
  | { type: "alias.list" }
  | { type: "alias.create"; name: string; folder: string; sessionId: string | null; pageRichness?: PageRichness }
  | { type: "alias.update"; id: string; name?: string; folder?: string; sessionId?: string | null; pageRichness?: PageRichness }
  | { type: "alias.delete"; id: string }
  | { type: "alias.select"; id: string }
  | { type: "settings.set"; permissionMode: PermissionModeSetting; model?: string; effort?: EffortLevelSetting };

export type ServerMessage =
  | { type: "auth.ok"; instance?: string }
  | { type: "auth.fail"; reason: string }
  | { type: "folder.bound"; path: string; resumed: boolean; title: string; sessionId: string | null }
  | { type: "folder.error"; message: string }
  // folder.picked：系统文件夹选择框结果；path 为 null = 用户取消或平台不支持
  | { type: "folder.picked"; path: string | null }
  | { type: "chat.delta"; text: string }
  | { type: "chat.tool"; name: string; summary: string }
  // chat.done 可选字段：model/effort = SDK init 上报的实际生效值；compacted = 本轮发生过 compact（扩展据此下一轮强制附带页面）
  | { type: "chat.done"; sessionId: string; model?: string; effort?: EffortLevelSetting | null; compacted?: boolean }
  | { type: "chat.error"; message: string }
  | { type: "permission.request"; requestId: string; tool: string; detail: string }
  | { type: "session.history.data"; messages: HistoryMessage[] }
  | { type: "session.list.data"; sessions: SessionInfo[]; currentId: string | null }
  | { type: "alias.list.data"; aliases: AliasInfo[]; currentId: string | null };

/** 页面信息丰富度档位：brief 精简 / standard 标准 / rich 丰富（对应附带网页时注入正文的最大字符数，档位上限见扩展 attach-policy） */
export type PageRichness = "brief" | "standard" | "rich";

/**
 * 校验页面信息丰富度档位字符串。
 * @param v 任意值
 * @returns 是否为合法 PageRichness
 */
export function isPageRichness(v: unknown): v is PageRichness {
  return v === "brief" || v === "standard" || v === "rich";
}

/**
 * 校验权限模式字符串。
 * @param v 任意值
 * @returns 是否为合法 PermissionModeSetting
 */
export function isPermissionMode(v: unknown): v is PermissionModeSetting {
  return v === "auto" || v === "acceptEdits" || v === "plan" || v === "approve-each";
}

/**
 * 校验 effort 档位字符串。
 * @param v 任意值
 * @returns 是否为合法 EffortLevelSetting
 */
export function isEffortLevel(v: unknown): v is EffortLevelSetting {
  return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max";
}

/**
 * 解析客户端消息。WS 帧不可信，任何非法输入返回 null，绝不抛异常。
 * @param raw 原始帧文本
 * @returns 合法消息或 null
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw);
    if (typeof m !== "object" || m === null) return null;
    switch (m.type) {
      case "auth":
        return typeof m.token === "string" ? m : null;
      case "client.ready":
      case "chat.abort":
      case "session.history":
      case "session.list":
      case "session.new":
      case "alias.list":
      case "folder.pick":
        return m;
      case "folder.bind":
        return typeof m.path === "string" && m.path.length > 0 ? m : null;
      case "chat.send": {
        if (typeof m.text !== "string" || m.text.length === 0) return null;
        if (m.uploads === undefined) return m; // 无附件：原样放行
        // uploads 全量严格校验：数量/名单/单文件/总量任一越界整帧拒绝（扩展侧已先做友好拦截，这里是防线）
        if (!Array.isArray(m.uploads) || m.uploads.length === 0 || m.uploads.length > MAX_UPLOAD_FILES) return null;
        let total = 0;
        const uploads: UploadFile[] = [];
        for (const u of m.uploads) {
          if (typeof u !== "object" || u === null) return null;
          if (typeof u.name !== "string" || u.name.length === 0 || u.name.length > 255) return null;
          if (typeof u.dataB64 !== "string" || u.dataB64.length === 0 || u.dataB64.length > MAX_UPLOAD_B64_CHARS) return null;
          total += u.dataB64.length;
          if (total > MAX_UPLOAD_TOTAL_B64) return null;
          uploads.push({ name: u.name, dataB64: u.dataB64 });
        }
        return { type: "chat.send", text: m.text, uploads };
      }
      case "permission.response":
        return typeof m.requestId === "string" && typeof m.allow === "boolean" ? m : null;
      case "session.switch":
      case "session.delete":
        return typeof m.sessionId === "string" && m.sessionId.length > 0 ? m : null;
      case "alias.create": {
        if (typeof m.name !== "string" || m.name.trim().length === 0
          || typeof m.folder !== "string" || m.folder.length === 0
          || (typeof m.sessionId !== "string" && m.sessionId !== null)) return null;
        // pageRichness 为可选字段：只接受合法档位，非法值剥掉（与 settings.set 的 model/effort 同一策略）
        const out: Extract<ClientMessage, { type: "alias.create" }> = { type: "alias.create", name: m.name, folder: m.folder, sessionId: m.sessionId };
        if (isPageRichness(m.pageRichness)) out.pageRichness = m.pageRichness;
        return out;
      }
      case "alias.update": {
        if (typeof m.id !== "string" || m.id.length === 0) return null;
        // 逐字段校验组装：可选字段只带合法值；sessionId 出现时必须显式是 string 或 null（允许改成"新会话"）
        const out: Extract<ClientMessage, { type: "alias.update" }> = { type: "alias.update", id: m.id };
        if (typeof m.name === "string" && m.name.trim().length > 0) out.name = m.name;
        if (typeof m.folder === "string" && m.folder.length > 0) out.folder = m.folder;
        if (isPageRichness(m.pageRichness)) out.pageRichness = m.pageRichness;
        if ("sessionId" in m) {
          if (typeof m.sessionId !== "string" && m.sessionId !== null) return null;
          out.sessionId = m.sessionId;
        }
        return out;
      }
      case "alias.delete":
      case "alias.select":
        return typeof m.id === "string" && m.id.length > 0 ? m : null;
      case "settings.set": {
        if (!isPermissionMode(m.permissionMode)) return null;
        // model/effort 为可选字段：只接受合法值，空串视为"跟随默认"（不下发）
        const model = typeof m.model === "string" && m.model.length > 0 ? m.model : undefined;
        const effort = isEffortLevel(m.effort) ? m.effort : undefined;
        return { type: "settings.set", permissionMode: m.permissionMode, model, effort };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 序列化服务消息为帧文本。
 * @param msg 服务消息
 * @returns JSON 字符串
 */
export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
