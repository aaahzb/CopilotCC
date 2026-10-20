import React, { useState } from "react";

/** 首次配对界面：输入桥接 token（桥接启动时打印在控制台） */
export function TokenGate(props: { error?: string; onSave(token: string, port: number): void }): React.ReactElement {
  const [token, setToken] = useState("");
  const [port, setPort] = useState("19280");
  return (
    <div className="token-gate">
      <h3>连接桥接服务</h3>
      <p className="hint">先运行 <code>npm start</code>（bridge 目录），把打印的 token 粘贴到这里。</p>
      {props.error ? <p className="error">{props.error}</p> : null}
      <input placeholder="token" value={token} onChange={(e) => setToken(e.target.value.trim())} />
      <input placeholder="端口" value={port} onChange={(e) => setPort(e.target.value.trim())} style={{ width: 90 }} />
      <button disabled={!token} onClick={() => props.onSave(token, Number(port) || 19280)}>连接</button>
    </div>
  );
}
