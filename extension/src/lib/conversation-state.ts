import type { ServerMessage } from "./protocol";

type FolderBound = Extract<ServerMessage, { type: "folder.bound" }>;

/**
 * 判断 folder.bound 是否应清空当前消息、流式文本和 busy。
 * @param message 桥接绑定消息；主动会话操作的 reset 不依赖可能仍为 null 的会话 ID
 * @param previousFolder 当前界面绑定的文件夹，尚未绑定时为 null
 * @param previousSessionId 当前界面的会话 ID，首轮回报前可为 null
 * @returns 主动 reset 或既有文件夹/会话变化时为 true；普通快照与重复绑定为 false
 */
export function shouldResetConversation(
  message: FolderBound,
  previousFolder: string | null,
  previousSessionId: string | null,
): boolean {
  return message.reset === true
    || (previousFolder !== null && previousFolder !== message.path)
    || (previousSessionId !== null && previousSessionId !== message.sessionId);
}
