/**
 * WS 消息协议（单一来源）。修改本文件后运行 scripts/sync-protocol.mjs 同步到两端。
 * 消息命名：客户端 → 服务用动词（chat.send），服务 → 客户端用结果（chat.delta）。
 */

/** 权限模式设置：auto=自动审批分类器；approve-each=聊天内逐条审批卡片 */
export type PermissionModeSetting = "auto" | "acceptEdits" | "plan" | "approve-each";

/** 历史回放消息 */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "client.ready" }
  | { type: "folder.bind"; path: string }
  | { type: "chat.send"; text: string }
  | { type: "chat.abort" }
  | { type: "permission.response"; requestId: string; allow: boolean }
  | { type: "session.history" }
  | { type: "settings.set"; permissionMode: PermissionModeSetting };

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
      case "settings.set":
        return isPermissionMode(m.permissionMode) ? m : null;
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
