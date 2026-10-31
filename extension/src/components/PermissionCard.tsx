import React, { useState } from "react";
import type { InteractionRequest } from "../lib/protocol";

/** 权限与退出计划审批卡；关键动作直显，完整参数和计划默认折叠。 */
export function PermissionCard(props: {
  request: (InteractionRequest & { tool: string; detail: string }) | null;
  onRespond(requestId: string, allow: boolean, feedback?: string): void;
}): React.ReactElement | null {
  const [feedback, setFeedback] = useState("");
  const r = props.request;
  if (!r) return null;
  const isPlan = r.kind === "exit_plan" || r.tool === "ExitPlanMode";
  const summary = r.summary || (isPlan ? "申请批准计划并继续执行" : `Claude 请求执行：${r.tool}`);
  return (
    <div className={`permission-card${isPlan ? " plan-card" : ""}`}>
      <div className="permission-summary"><b>{isPlan ? "计划审批" : "操作审批"}</b><span>{summary}</span></div>
      <div className="permission-tool">工具：{r.tool}</div>
      {r.planFilePath ? <div className="plan-file" title={r.planFilePath}>计划文件：{r.planFilePath}</div> : null}
      {r.plan !== undefined ? (
        <details className="plan-detail">
          <summary>查看完整计划</summary>
          <pre>{r.plan || "（空计划）"}</pre>
        </details>
      ) : null}
      {r.detail ? (
        <details className="permission-detail">
          <summary>技术详情（完整参数）</summary>
          <pre>{r.detail}</pre>
        </details>
      ) : null}
      {isPlan ? (
        <label className="plan-feedback">
          退回意见（可选）
          <textarea
            value={feedback}
            placeholder="告诉 Claude 需要修改什么"
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      ) : null}
      <div className="row">
        <button
          className="allow"
          onClick={() => isPlan
            ? props.onRespond(r.requestId, true, undefined)
            : props.onRespond(r.requestId, true)}
        >
          {isPlan ? "批准并继续" : "允许"}
        </button>
        <button
          className="deny"
          onClick={() => isPlan
            ? props.onRespond(r.requestId, false, feedback.trim() || undefined)
            : props.onRespond(r.requestId, false)}
        >
          {isPlan ? "继续修改" : "拒绝"}
        </button>
      </div>
    </div>
  );
}
