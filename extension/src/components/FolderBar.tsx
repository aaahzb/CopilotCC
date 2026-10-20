import React, { useEffect, useState } from "react";
import type { SessionInfo } from "../lib/protocol";

/** 顶部文件夹栏：路径输入 + 文件夹切换 + 会话切换 + 新建/删除会话 + 续聊标识 + 续接命令复制 */
export function FolderBar(props: {
  history: string[];
  bound: string | null;
  resumed: boolean;
  /** 当前会话 ID（folder.bound 携带或 session.list.data/chat.done 推送），用于生成 cmd 续接命令 */
  sessionId: string | null;
  /** 当前绑定文件夹下的会话列表（mtime 倒序） */
  sessions: SessionInfo[];
  onBind(path: string): void;
  onNewSession(): void;
  onSwitchSession(sessionId: string): void;
  onDeleteSession(sessionId: string): void;
}): React.ReactElement {
  const [value, setValue] = useState(props.bound ?? "");
  const [copied, setCopied] = useState(false);

  // useState 只在挂载时初始化一次：自动回绑/切换文件夹后，把已绑定路径回填进输入框
  useEffect(() => {
    if (props.bound) setValue(props.bound);
  }, [props.bound]);

  /** 一键复制 cmd 续接命令：claude --resume <sessionId> */
  function copyResumeCmd(): void {
    if (!props.sessionId) return;
    void navigator.clipboard.writeText(`claude --resume ${props.sessionId}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  /**
   * 会话下拉条目文案：标题 + 最后活跃时间（MM-DD HH:mm）。
   * @param s 会话项
   * @returns 展示文本
   */
  function sessionLabel(s: SessionInfo): string {
    const d = new Date(s.updatedAt);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${s.title}（${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}）`;
  }

  /** 删除当前会话（弹确认；删的是本地转录文件，不可恢复） */
  function confirmDelete(): void {
    if (!props.sessionId) return;
    if (window.confirm("确定删除当前会话？会同时删除本地转录文件，不可恢复。")) {
      props.onDeleteSession(props.sessionId);
    }
  }

  return (
    <div className="folder-bar">
      <div className="folder-bar-row">
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
      </div>
      <div className="folder-bar-row">
        {props.history.length > 0 ? (
          <select
            className="chat-switch"
            title="切换到绑过的文件夹"
            value=""
            onChange={(e) => {
              if (e.target.value) props.onBind(e.target.value);
            }}
          >
            <option value="" disabled>切换文件夹…</option>
            {props.history.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        ) : null}
        {props.bound ? (
          <>
            <select
              className="chat-switch session-switch"
              title="切换当前文件夹下的会话"
              value=""
              onChange={(e) => {
                if (e.target.value) props.onSwitchSession(e.target.value);
              }}
            >
              <option value="" disabled>切换会话…</option>
              {props.sessions.length === 0 ? <option key="empty" value="__none" disabled>（此文件夹暂无历史会话）</option> : null}
              {props.sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId === props.sessionId ? "▶ " : ""}
                  {sessionLabel(s)}
                </option>
              ))}
            </select>
            <button className="mini-btn" title="在当前文件夹新建会话" onClick={props.onNewSession}>＋新会话</button>
            <button
              className="mini-btn danger"
              title="删除当前会话（含本地转录文件）"
              onClick={confirmDelete}
              disabled={!props.sessionId}
            >
              🗑删会话
            </button>
          </>
        ) : null}
      </div>
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
