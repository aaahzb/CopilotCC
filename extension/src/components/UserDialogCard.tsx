import React from "react";
import type {
  InteractionRequest,
  UserDialogAction,
  UserDialogResponse,
} from "../lib/protocol";

/** 五种 CLI 对话框结果的中文事实文案，挂起卡与只读记录共用。 */
export const USER_DIALOG_ACTION_TEXT: Record<UserDialogAction, string> = {
  retry_fallback: "使用回退模型重试",
  edit_prompt: "修改提问后重试",
  continue: "继续自动模式",
  interrupt: "停止本轮",
  cancelled: "已取消",
};

/** 仅允许 http/https 帮助页，并移除地址中的用户名和密码。 */
export function safeUserDialogUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}

/** CLI 自有对话框专用卡；只提交本机 CLI 已验证的枚举结果。 */
export function UserDialogCard(props: {
  request: InteractionRequest;
  onRespond(requestId: string, response: UserDialogResponse): void;
}): React.ReactElement | null {
  const { request } = props;
  const info = request.userDialog;
  if (request.kind !== "user_dialog" || !info) return null;

  /** 把按钮对应的枚举原样交给桥接，由 SDK 包装成 completed/cancelled。 */
  function respond(action: UserDialogAction): void {
    props.onRespond(request.requestId, { action });
  }

  const helpUrl = info.dialogKind === "auto_mode_server_fallback"
    ? safeUserDialogUrl(info.helpUrl)
    : null;
  return (
    <section className="user-dialog-card" data-request-id={request.requestId}>
      <div className="elicitation-heading">
        <b>{info.dialogKind === "refusal_fallback_prompt" ? "模型回退确认" : info.title}</b>
      </div>
      {info.dialogKind === "refusal_fallback_prompt" ? (
        <div className="user-dialog-detail">
          <div>原模型：{info.originalModel}</div>
          <div>回退模型：{info.fallbackModel}</div>
          {info.apiRefusalCategory ? <div>拒绝类别：{info.apiRefusalCategory}</div> : null}
          {info.guidanceText ? <div className="user-dialog-guidance">{info.guidanceText}</div> : null}
        </div>
      ) : (
        <div className="user-dialog-detail">
          {info.gatewayHost ? <div>服务：{info.gatewayHost}</div> : null}
          {info.paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph}`}>{paragraph}</p>)}
          {helpUrl ? (
            <a href={helpUrl} target="_blank" rel="noopener noreferrer">查看完整说明</a>
          ) : null}
        </div>
      )}
      <div className="row">
        {info.dialogKind === "refusal_fallback_prompt" ? (
          <>
            <button className="allow" onClick={() => respond("retry_fallback")}>使用回退模型重试</button>
            <button onClick={() => respond("edit_prompt")}>返回修改提问</button>
          </>
        ) : (
          <>
            <button className="allow" onClick={() => respond("continue")}>继续自动模式</button>
            <button className="deny" onClick={() => respond("interrupt")}>停止本轮</button>
          </>
        )}
        <button onClick={() => respond("cancelled")}>取消</button>
      </div>
    </section>
  );
}
