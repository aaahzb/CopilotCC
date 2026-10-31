import React, { useState } from "react";
import {
  validateElicitationContent,
  type ElicitationFormField,
  type ElicitationResponse,
  type ElicitationValue,
  type InteractionRequest,
} from "../lib/protocol";

/** 链接卡只显示主机来源，避免把令牌、凭据或片段当成普通文案展示。 */
function elicitationUrlOrigin(raw: string | undefined): string {
  if (!raw) return "未提供链接";
  try {
    return new URL(raw).origin;
  } catch {
    return "链接格式无效";
  }
}

/** MCP 表单/URL 专用交互卡；表单值仅存在本地并用于当次应答。 */
export function ElicitationCard(props: {
  request: InteractionRequest;
  onRespond(requestId: string, response: ElicitationResponse): void;
}): React.ReactElement | null {
  const { request } = props;
  const info = request.elicitation;
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() => Object.fromEntries(
    (info?.fields ?? [])
      .filter((field) => field.default !== undefined)
      .map((field) => [field.name, field.default!]),
  ));
  const [errors, setErrors] = useState<string[]>([]);
  if (!info) return null;
  const fields = info.fields ?? [];
  const url = info.url;

  /** 更新单个字段；清空数字输入表示未填写，而不是误传 0。 */
  function setValue(field: ElicitationFormField, value: ElicitationValue | undefined): void {
    setErrors([]);
    setValues((current) => {
      const next = { ...current };
      if (value === undefined) delete next[field.name];
      else next[field.name] = value;
      return next;
    });
  }

  /** 本地先校验，错误保留在卡上；桥接仍会做第二次权威校验。 */
  function acceptForm(): void {
    const nextErrors = validateElicitationContent(fields, values);
    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }
    props.onRespond(request.requestId, { action: "accept", content: values });
  }

  /** URL 必须由真实点击触发打开，随后立即接受，不能等待 complete 才回调 SDK。 */
  function acceptUrl(): void {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
    props.onRespond(request.requestId, { action: "accept" });
  }

  return (
    <section className="elicitation-card" data-request-id={request.requestId}>
      <div className="elicitation-heading">
        <b>MCP 请求：{info.displayName || info.serverName}</b>
        {info.title ? <span>{info.title}</span> : null}
      </div>
      <div className="elicitation-message">{info.message}</div>
      {info.description ? <div className="elicitation-description">{info.description}</div> : null}
      {info.mode === "form" ? (
        <div className="elicitation-fields">
          {(info.fields ?? []).map((field) => {
            const value = values[field.name];
            const label = <>{field.title}{field.required ? <span className="required"> *</span> : null}</>;
            return (
              <label className="elicitation-field" key={field.name}>
                <span>{label}</span>
                {field.description ? <small>{field.description}</small> : null}
                {field.type === "boolean" ? (
                  <input
                    name={field.name}
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) => setValue(field, event.target.checked)}
                  />
                ) : field.enum ? (
                  <select
                    name={field.name}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => setValue(field, event.target.value || undefined)}
                  >
                    <option value="">请选择</option>
                    {field.enum.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : field.type === "number" || field.type === "integer" ? (
                  <input
                    name={field.name}
                    type="number"
                    step={field.type === "integer" ? 1 : "any"}
                    value={typeof value === "number" ? String(value) : ""}
                    onChange={(event) => setValue(field, event.target.value === "" ? undefined : Number(event.target.value))}
                  />
                ) : (
                  <input
                    name={field.name}
                    type="text"
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => setValue(field, event.target.value)}
                  />
                )}
              </label>
            );
          })}
        </div>
      ) : (
        <div className="elicitation-url">链接来源：{elicitationUrlOrigin(info.url)}</div>
      )}
      {errors.length > 0 ? <div className="elicitation-errors" role="alert">{errors.join("；")}</div> : null}
      <div className="row">
        <button
          className="allow"
          disabled={info.mode === "url" && !info.url}
          onClick={info.mode === "form" ? acceptForm : acceptUrl}
        >
          {info.mode === "form" ? "提交" : "打开链接并继续"}
        </button>
        <button className="deny" onClick={() => props.onRespond(request.requestId, { action: "decline" })}>拒绝</button>
        <button onClick={() => props.onRespond(request.requestId, { action: "cancel" })}>取消</button>
      </div>
    </section>
  );
}
