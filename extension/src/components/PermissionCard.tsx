import React from "react";

/** 权限审批卡片（仅"逐条审批"模式出现） */
export function PermissionCard(props: {
  request: { requestId: string; tool: string; detail: string } | null;
  onRespond(requestId: string, allow: boolean): void;
}): React.ReactElement | null {
  const r = props.request;
  if (!r) return null;
  return (
    <div className="permission-card">
      <div><b>Claude 请求执行：</b>{r.tool}</div>
      <pre>{r.detail}</pre>
      <div className="row">
        <button className="allow" onClick={() => props.onRespond(r.requestId, true)}>允许</button>
        <button className="deny" onClick={() => props.onRespond(r.requestId, false)}>拒绝</button>
      </div>
    </div>
  );
}
