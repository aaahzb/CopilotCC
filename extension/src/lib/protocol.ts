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
  /** 附带标记：full=页面全文，selection=仅选中文字 */
  attachKind?: "full" | "selection";
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "client.ready" }
  | { type: "folder.bind"; path: string }
  | { type: "chat.send"; text: string }
  | { type: "chat.abort" }
  | { type: "permission.response"; requestId: string; allow: boolean }
  | { type: "session.history" }
  | { type: "settings.set"; permissionMode: PermissionModeSetting; model?: string; effort?: EffortLevelSetting };

export type ServerMessage =
  | { type: "auth.ok" }
  | { type: "auth.fail"; reason: string }
  | { type: "folder.bound"; path: string; resumed: boolean; title: string; sessionId: string | null }
  | { type: "folder.error"; message: string }
  | { type: "chat.delta"; text: string }
  | { type: "chat.tool"; name: string; summary: string }
  | { type: "chat.done"; sessionId: string }
  | { type: "chat.error"; message: string }
  | { type: "permission.request"; requestId: string; tool: string; detail: string }
  | { type: "session.history.data"; messages: HistoryMessage[] };

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
        return m;
      case "folder.bind":
        return typeof m.path === "string" && m.path.length > 0 ? m : null;
      case "chat.send":
        return typeof m.text === "string" && m.text.length > 0 ? m : null;
      case "permission.response":
        return typeof m.requestId === "string" && typeof m.allow === "boolean" ? m : null;
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
