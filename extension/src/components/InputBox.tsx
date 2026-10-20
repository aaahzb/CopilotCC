import React, { useState } from "react";
import type { PermissionModeSetting, EffortLevelSetting } from "../lib/protocol";

/** 底部输入区：附带开关、权限模式/模型/effort 选择（同一行）、发送/停止 */
export function InputBox(props: {
  disabled: boolean;
  streaming: boolean;
  attachEnabled: boolean;
  permissionMode: PermissionModeSetting;
  /** 模型别名；空串 = 跟随 CLI 配置 */
  model: string;
  /** 推理强度；空串 = 默认 */
  effort: EffortLevelSetting | "";
  /** 桥接上报的实际生效模型（已压短）；优先于手动选择显示，未知 = undefined */
  effectiveModel?: string;
  /** 桥接上报的实际生效 effort；null/undefined = 不显示 */
  effectiveEffort?: EffortLevelSetting | null;
  onToggleAttach(v: boolean): void;
  onModeChange(m: PermissionModeSetting): void;
  onModelChange(v: string): void;
  onEffortChange(v: EffortLevelSetting | ""): void;
  onSend(text: string): void;
  onStop(): void;
}): React.ReactElement {
  const [text, setText] = useState("");
  const submit = (): void => {
    if (!text.trim() || props.disabled) return;
    props.onSend(text.trim());
    setText("");
  };
  // 指示文本：手动选择优先（刚改下拉时上报值还是旧会话的），其次桥接上报的实际生效值；都不知道就不显示（绝不显示"默认"二字）
  const modelText = props.model || props.effectiveModel || "";
  const effortText = props.effort || (props.effectiveEffort ?? "");
  const hint = [modelText ? `模型 ${modelText}` : "", effortText ? `effort ${effortText}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="input-box">
      <div className="toggles">
        <label>
          <input type="checkbox" checked={props.attachEnabled} onChange={(e) => props.onToggleAttach(e.target.checked)} />
          附带网页
        </label>
        <select value={props.permissionMode} title="权限模式" onChange={(e) => props.onModeChange(e.target.value as PermissionModeSetting)}>
          <option value="auto">auto 自动</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="plan">plan</option>
          <option value="approve-each">逐条审批</option>
        </select>
        <select value={props.model} title="模型" onChange={(e) => props.onModelChange(e.target.value)}>
          <option value="">模型默认</option>
          <option value="fable">fable</option>
          <option value="opus">opus</option>
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
        </select>
        <select value={props.effort} title="推理强度（effort）" onChange={(e) => props.onEffortChange(e.target.value as EffortLevelSetting | "")}>
          <option value="">effort 默认</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
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
      {/* 发送行：最左只读显示当前生效的模型·effort（改动入口是上方下拉），发送/停止按钮靠右 */}
      <div className="send-row">
        <span className="model-effort" title="当前生效的模型与推理强度（首轮回复后显示实际值；在上方下拉修改）">{hint}</span>
        {props.streaming ? (
          <button onClick={props.onStop}>停止</button>
        ) : (
          <button disabled={props.disabled || !text.trim()} onClick={submit}>发送</button>
        )}
      </div>
    </div>
  );
}
