import React from "react";
import type { InteractionRecord } from "../lib/protocol";
import { safeUserDialogUrl, USER_DIALOG_ACTION_TEXT } from "./UserDialogCard";

const OUTCOME_TEXT: Record<InteractionRecord["outcome"], string> = {
  answered: "已回答",
  allowed: "已允许",
  denied: "已拒绝",
  cancelled: "已取消",
  timeout: "等待超时，已取消",
  error: "处理失败",
};

/**
 * 已解决交互的只读中文记录；问题、答案和决定直接显示，技术详情默认折叠。
 * @param props.record 桥接或 CLI 转录提供的同一份交互结果
 * @returns 只读记录卡片
 */
export function InteractionRecordView(props: { record: InteractionRecord }): React.ReactElement {
  const { record } = props;
  const title = record.kind === "ask"
    ? "Claude 的提问"
    : record.kind === "exit_plan"
      ? "计划审批"
      : record.kind === "elicitation"
        ? `MCP 请求：${record.elicitation?.displayName || record.elicitation?.serverName || "未知服务"}`
        : record.kind === "user_dialog"
          ? record.userDialog?.dialogKind === "auto_mode_server_fallback"
            ? record.userDialog.title || "自动模式确认"
            : "模型回退确认"
          : `操作审批${record.tool ? `：${record.tool}` : ""}`;
  const outcomeText = record.kind === "user_dialog" && record.userDialogAction
    ? USER_DIALOG_ACTION_TEXT[record.userDialogAction]
    : record.kind === "elicitation" && record.elicitationAction === "accept"
      ? "已接受"
      : OUTCOME_TEXT[record.outcome];
  return (
    <section className={`interaction-record ${record.outcome}`} data-request-id={record.requestId}>
      <div className="interaction-record-title"><b>{title}</b><span>{outcomeText}</span></div>
      {record.kind === "user_dialog" && record.userDialog ? (
        <div className="user-dialog-record-detail">
          {record.userDialogAction
            ? <div><b>你的选择：{USER_DIALOG_ACTION_TEXT[record.userDialogAction]}</b></div>
            : null}
          {record.userDialog.dialogKind === "refusal_fallback_prompt" ? (
            <>
              <div>原模型：{record.userDialog.originalModel}</div>
              <div>回退模型：{record.userDialog.fallbackModel}</div>
              {record.userDialog.apiRefusalCategory
                ? <div>拒绝类别：{record.userDialog.apiRefusalCategory}</div> : null}
              {record.userDialog.guidanceText ? <div>{record.userDialog.guidanceText}</div> : null}
            </>
          ) : (
            <>
              {record.userDialog.gatewayHost ? <div>服务：{record.userDialog.gatewayHost}</div> : null}
              {record.userDialog.paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph}`}>{paragraph}</p>)}
              {safeUserDialogUrl(record.userDialog.helpUrl) ? (
                <a
                  href={safeUserDialogUrl(record.userDialog.helpUrl)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >查看完整说明</a>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {record.kind === "elicitation" && record.elicitation ? (
        <div className="elicitation-record-detail">
          <div>{record.elicitation.message}</div>
          {record.submittedFields && record.submittedFields.length > 0
            ? <div><b>已提交字段：</b>{record.submittedFields.join("、")}</div>
            : null}
          {record.elicitation.url ? <div>链接：{record.elicitation.url}</div> : null}
          {record.elicitationComplete ? <div><b>链接流程已完成</b></div> : null}
        </div>
      ) : null}
      {record.kind === "ask" && record.answers ? (
        <div className="interaction-answers">
          {(record.questions ?? []).map((question, index) => (
            <div className="interaction-answer" key={`${index}-${question.question}`}>
              <div>{question.question}</div>
              <div><b>你的选择：{record.answers?.[question.question] ?? "（未记录答案）"}</b></div>
            </div>
          ))}
          {(record.questions ?? []).length === 0
            ? Object.entries(record.answers).map(([question, answer]) => (
              <div className="interaction-answer" key={question}>
                <div>{question}</div><div><b>你的选择：{answer}</b></div>
              </div>
            ))
            : null}
        </div>
      ) : null}
      {record.feedback ? <div className="interaction-feedback"><b>你的意见：</b>{record.feedback}</div> : null}
      {record.plan ? <details className="interaction-detail"><summary>查看完整计划</summary><pre>{record.plan}</pre></details> : null}
      {record.detail ? <details className="interaction-detail"><summary>技术详情</summary><pre>{record.detail}</pre></details> : null}
    </section>
  );
}
