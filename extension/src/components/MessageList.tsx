import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 界面消息：user/assistant 聊天气泡，tool 为折叠工具卡片 */
export interface UiMsg {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
}

export function MessageList(props: { messages: UiMsg[]; streaming: string | null }): React.ReactElement {
  return (
    <div className="message-list">
      {props.messages.map((m) =>
        m.role === "tool" ? (
          <details key={m.id} className="tool-card"><summary>{m.text}</summary></details>
        ) : (
          <div key={m.id} className={`msg ${m.role}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
          </div>
        ),
      )}
      {props.streaming !== null ? (
        <div className="msg assistant streaming">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{props.streaming}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}
