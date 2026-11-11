import type { UiMsg } from "../components/MessageList";
import type { HistoryMessage, ServerMessage } from "./protocol";

export interface TerminalMirrorView {
  sessionId: string | null;
  revision: number;
  messages: UiMsg[];
  hasLoadedOlder: boolean;
}

/** 历史/实时/镜像共用 upsert：工具执行与交互决定各占一行，最终状态不被 running 回退。 */
export function upsertUiMessage(current: UiMsg[], item: UiMsg): UiMsg[] {
  const index = current.findIndex((old) => {
    if (item.interaction) {
      return old.interaction?.requestId === item.interaction.requestId
        || Boolean(item.interaction.toolUseId && old.interaction?.toolUseId === item.interaction.toolUseId);
    }
    return Boolean(item.toolUseId && !old.interaction && old.toolUseId === item.toolUseId) || old.id === item.id;
  });
  if (index < 0) return [...current, item];
  const old = current[index]!;
  const oldFinal = old.toolStatus === "success" || old.toolStatus === "error";
  const next = [...current];
  next[index] = {
    ...old,
    ...item,
    id: old.id,
    interaction: item.interaction ?? old.interaction,
    toolInput: item.toolInput ?? old.toolInput,
    toolOutput: item.toolOutput ?? old.toolOutput,
    toolStatus: oldFinal && (item.toolStatus === "running" || item.toolStatus === "unknown")
      ? old.toolStatus
      : item.toolStatus ?? old.toolStatus,
  };
  return next;
}

/**
 * 将结构化历史转为界面消息；缺稳定 ID 的旧桥消息使用本页确定性的备用 ID。
 * @param item 桥接历史项
 * @param fallbackId 当前会话/revision/序号组成的备用 ID
 * @returns 可渲染的完整界面消息
 */
export function toUiMessage(item: HistoryMessage, fallbackId: string): UiMsg {
  return {
    id: item.id ?? fallbackId,
    role: item.role,
    toolName: item.toolName,
    text: item.text,
    sentText: item.sentText,
    attachKind: item.attachKind,
    interaction: item.interaction,
    toolUseId: item.toolUseId,
    toolStatus: item.toolStatus,
    toolInput: item.toolInput,
    toolOutput: item.toolOutput,
    detail: item.detail,
  };
}

/**
 * 合并终端只读镜像，只接受预期 sessionId 和更高 revision，并保留已加载旧分页。
 * @param view 当前镜像视图
 * @param message 新到的一页镜像
 * @param expectedSessionId UI 当前确认的会话
 * @returns 新视图；过期或异会话包返回原对象
 */
export function reduceTerminalMirror(
  view: TerminalMirrorView,
  message: Extract<ServerMessage, { type: "session.mirror.data" }>,
  expectedSessionId: string | null,
): TerminalMirrorView {
  if (expectedSessionId === null || message.sessionId !== expectedSessionId) return view;
  if (view.sessionId === message.sessionId && message.revision <= view.revision) return view;
  const items = message.messages.map((item, index) => toUiMessage(
    item,
    `mirror-${message.sessionId}-${message.revision}-${index}`,
  ));
  if (view.sessionId !== message.sessionId) {
    return {
      sessionId: message.sessionId,
      revision: message.revision,
      messages: items,
      hasLoadedOlder: false,
    };
  }
  return {
    ...view,
    revision: message.revision,
    messages: items.reduce(upsertUiMessage, [...view.messages]),
  };
}
