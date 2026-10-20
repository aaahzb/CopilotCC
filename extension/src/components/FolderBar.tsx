import React, { useState } from "react";

/** 顶部文件夹栏：路径输入 + 历史下拉 + 绑定按钮 + 续聊标识 */
export function FolderBar(props: {
  history: string[];
  bound: string | null;
  resumed: boolean;
  onBind(path: string): void;
}): React.ReactElement {
  const [value, setValue] = useState(props.bound ?? "");
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
        </div>
      ) : null}
    </div>
  );
}
