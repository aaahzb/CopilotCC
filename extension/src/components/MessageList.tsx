import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 界面消息：user/assistant 聊天气泡，tool 为折叠工具卡片 */
export interface UiMsg {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** 实际发送给 Claude 的完整文本（含页面上下文），仅用户消息有 */
  sentText?: string;
  /** 附带标记：full=页面全文，selection=选中文字；无标记=未附带 */
  attachKind?: "full" | "selection";
}

/**
 * 消息列表。用户气泡支持附带角标（📄全文/📎选中）与右键查看实际发送内容。
 * @param props.messages 已落地的消息列表
 * @param props.streaming 正在流式生成、尚未落地的 assistant 文本
 * @returns 消息列表 React 元素
 */
export function MessageList(props: { messages: UiMsg[]; streaming: string | null }): React.ReactElement {
  const [viewing, setViewing] = useState<UiMsg | null>(null); // 右键查看中的消息
  return (
    <div className="message-list">
      {props.messages.map((m) =>
        m.role === "tool" ? (
          m.sentText ? (
            // 附带状态行：平时一行折叠态，点击弹出临时浮层查看完整发送内容，关闭即消失
            <div key={m.id} className="tool-card clickable" title="点击查看实际发送内容" onClick={() => setViewing(m)}>
              {m.text} 🔍
            </div>
          ) : (
            <div key={m.id} className="tool-card">{m.text}</div>
          )
        ) : (
          <div
            key={m.id}
            className={`msg ${m.role}`}
            title={m.sentText ? "右键查看实际发送内容" : undefined}
            onContextMenu={m.sentText ? (e) => { e.preventDefault(); setViewing(m); } : undefined}
          >
            {m.attachKind ? (
              <span className="attach-mark" title={m.attachKind === "full" ? "已附带页面全文" : "已附带选中文字"}>
                {m.attachKind === "full" ? "📄" : "📎"}
              </span>
            ) : null}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
          </div>
        ),
      )}
      {props.streaming !== null ? (
        <div className="msg assistant streaming">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.streaming}</ReactMarkdown>
        </div>
      ) : null}
      {viewing ? (
        <div className="sent-viewer" onClick={() => setViewing(null)}>
          <div className="sent-viewer-box" onClick={(e) => e.stopPropagation()}>
            <div className="sent-viewer-head">
              <span>实际发送给 Claude 的完整内容</span>
              <button onClick={() => void navigator.clipboard.writeText(viewing.sentText ?? viewing.text)}>复制</button>
              <button onClick={() => setViewing(null)}>关闭</button>
            </div>
            <pre>{viewing.sentText ?? viewing.text}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
