import React, { useState } from "react";
import type { PermissionModeSetting } from "../lib/protocol";

/** 底部输入区：附带开关、权限模式选择、发送/停止 */
export function InputBox(props: {
  disabled: boolean;
  streaming: boolean;
  attachEnabled: boolean;
  permissionMode: PermissionModeSetting;
  onToggleAttach(v: boolean): void;
  onModeChange(m: PermissionModeSetting): void;
  onSend(text: string): void;
  onStop(): void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const submit = (): void => {
    if (!text.trim() || props.disabled) return;
    props.onSend(text.trim());
    setText("");
  };
  return (
    <div className="input-box">
      <div className="toggles">
        <label>
          <input type="checkbox" checked={props.attachEnabled} onChange={(e) => props.onToggleAttach(e.target.checked)} />
          附带网页
        </label>
        <select value={props.permissionMode} onChange={(e) => props.onModeChange(e.target.value as PermissionModeSetting)}>
          <option value="auto">auto 自动</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="plan">plan</option>
          <option value="approve-each">逐条审批</option>
        </select>
      </div>
      <textarea
        rows={3}
        placeholder={props.disabled ? "先绑定文件夹…" : "针对当前网页提问，Enter 发送 / Shift+Enter 换行"}
        value={text}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {props.streaming ? (
        <button onClick={props.onStop}>停止</button>
      ) : (
        <button disabled={props.disabled || !text.trim()} onClick={submit}>发送</button>
      )}
    </div>
  );
}
