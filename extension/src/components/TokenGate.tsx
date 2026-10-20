import React, { useState } from "react";
import { decodePairing, type PairingInfo } from "../lib/pairing";

/** 配对界面：粘贴桥接配对串（ccc1. 开头，内含地址+端口+token）；兼容直接粘贴裸 token（默认 127.0.0.1:19280） */
export function TokenGate(props: {
  error?: string;
  /** 传入时显示"取消"按钮（中途重新配对可返回，首次配对无此按钮） */
  onCancel?: () => void;
  onSave(info: PairingInfo): void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  /** 解析配对串并保存；无法识别就地提示 */
  function submit(): void {
    const info = decodePairing(text);
    if (info) props.onSave(info);
    else setBad(true);
  }

  return (
    <div className="token-gate">
      <h3>连接桥接服务</h3>
      <p className="hint">
        托盘图标右键 →「复制配对串」，粘贴到下面即可（地址、端口、Token 都在这一串里）。开发模式可运行 <code>npm start</code> 查看配对串。
      </p>
      {props.error ? <p className="error">{props.error}</p> : null}
      {bad ? <p className="error">配对串无法识别：应以 ccc1. 开头（旧流程也可直接粘贴 token）</p> : null}
      <input
        placeholder="ccc1.…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => e.key === "Enter" && text.trim() && submit()}
      />
      <div className="token-gate-actions">
        <button disabled={!text.trim()} onClick={submit}>连接</button>
        {props.onCancel ? <button onClick={props.onCancel}>取消</button> : null}
      </div>
    </div>
  );
}
