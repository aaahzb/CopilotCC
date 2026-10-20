import React, { useState } from "react";

/** 顶部文件夹栏：路径输入 + 历史下拉 + 绑定按钮 + 切换聊天 + 续聊标识 + 会话续接命令复制 */
export function FolderBar(props: {
  history: string[];
  bound: string | null;
  resumed: boolean;
  /** 当前会话 ID（folder.bound 携带或 chat.done 推送），用于生成 cmd 续接命令 */
  sessionId: string | null;
  onBind(path: string): void;
}): React.ReactElement {
  const [value, setValue] = useState(props.bound ?? "");
  const [copied, setCopied] = useState(false);

  /** 一键复制 cmd 续接命令：claude --resume <sessionId> */
  function copyResumeCmd(): void {
    if (!props.sessionId) return;
    void navigator.clipboard.writeText(`claude --resume ${props.sessionId}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="folder-bar">
      <input
        list="ccc-folder-history"
        placeholder="绑定文件夹绝对路径，如 D:\notes"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && props.onBind(value)}
      />
      <datalist id="ccc-folder-history">
        {props.history.map((h) => <option key={h} value={h} />)}
      </datalist>
      <button onClick={() => props.onBind(value)}>绑定</button>
      {props.history.length > 0 ? (
        <select
          className="chat-switch"
          title="切换到绑过的文件夹聊天"
          value=""
          onChange={(e) => {
            if (e.target.value) props.onBind(e.target.value);
          }}
        >
          <option value="" disabled>切换聊天…</option>
          {props.history.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
      ) : null}
      {props.bound ? (
        <div className="bound-info">
          {props.bound}
          {props.resumed ? <span className="badge">已续聊</span> : null}
          {props.sessionId ? (
            <button
              className="session-chip"
              title={`点击复制 cmd 续接命令：claude --resume ${props.sessionId}`}
              onClick={copyResumeCmd}
            >
              {copied ? "已复制 ✓" : `会话 ${props.sessionId.slice(0, 8)}… ⧉`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
