import React, { useState } from "react";
import type { AskRequest } from "../lib/protocol";

const OTHER_VALUE = "__other__";

type Respond = (requestId: string, answers: Record<string, string>) => void;

/**
 * AskUserQuestion 提问卡片；requestId 变化时通过 key 重置上一次的选择。
 * @param props 挂起提问与提交回调
 * @returns 提问卡片；无挂起提问时返回 null
 */
export function AskCard(props: { request: AskRequest | null; onRespond: Respond }): React.ReactElement | null {
  const request = props.request;
  if (!request) return null;
  return <AskForm key={request.requestId} request={request} onRespond={props.onRespond} />;
}

/**
 * 一次提问的作答表单，支持多问题、单选、多选与 Other 自由文本。
 * @param props 非空提问与提交回调
 * @returns 可提交的作答表单
 */
function AskForm(props: { request: AskRequest; onRespond: Respond }): React.ReactElement {
  const { request } = props;
  // 选项按题号记录；数组顺序就是用户选择顺序，多选答案据此连接
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  /**
   * 切换一个预置选项或 Other；单选替换，多选增删。
   * @param index 问题下标
   * @param value 选项 label，Other 使用内部哨兵值
   * @param multiSelect 是否多选
   * @returns 无返回值
   */
  function toggle(index: number, value: string, multiSelect: boolean): void {
    setSelected((current) => {
      const old = current[index] ?? [];
      const next = multiSelect
        ? (old.includes(value) ? old.filter((v) => v !== value) : [...old, value])
        : [value];
      return { ...current, [index]: next };
    });
  }

  /**
   * 计算一题的最终答案；Other 文本去除首尾空白并作为最后一个答案项。
   * @param index 问题下标
   * @returns 单选一个值，多选以 ", " 连接；未完整作答时为空串
   */
  function answerAt(index: number): string {
    const values = selected[index] ?? [];
    const parts = values.filter((v) => v !== OTHER_VALUE);
    if (values.includes(OTHER_VALUE)) {
      const custom = (otherText[index] ?? "").trim();
      if (custom) parts.push(custom);
    }
    return parts.join(", ");
  }

  const complete = request.questions.every((_, index) => answerAt(index).length > 0);

  /**
   * 提交完整 answers 映射，键严格使用 CC 给出的问题文本。
   * @param event 表单提交事件
   * @returns 无返回值
   */
  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (!complete) return;
    const answers: Record<string, string> = {};
    request.questions.forEach((q, index) => { answers[q.question] = answerAt(index); });
    props.onRespond(request.requestId, answers);
  }

  return (
    <div className="ask-card">
      <b>Claude 想确认：</b>
      <form onSubmit={submit}>
        {request.questions.map((q, index) => {
          const values = selected[index] ?? [];
          return (
            <fieldset className="ask-question" key={`${index}-${q.question}`}>
              <legend>{q.header}</legend>
              <div className="ask-question-text">{q.question}</div>
              <div className="ask-options">
                {q.options.map((o) => (
                  <label className="ask-option" key={o.label}>
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={`ask-${request.requestId}-${index}`}
                      value={o.label}
                      checked={values.includes(o.label)}
                      onChange={() => toggle(index, o.label, q.multiSelect)}
                    />
                    <span>{o.label}{o.description && <small>{o.description}</small>}</span>
                  </label>
                ))}
                {q.options.filter((o) => o.preview).map((o) => (
                  <details className="ask-preview" key={`${o.label}-preview`}>
                    <summary>查看「{o.label}」预览</summary>
                    <pre>{o.preview}</pre>
                  </details>
                ))}
                <label className="ask-option">
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`ask-${request.requestId}-${index}`}
                    value={OTHER_VALUE}
                    checked={values.includes(OTHER_VALUE)}
                    onChange={() => toggle(index, OTHER_VALUE, q.multiSelect)}
                  />
                  <span>其他（自定义）</span>
                </label>
              </div>
              {values.includes(OTHER_VALUE) && (
                <input
                  className="ask-other"
                  type="text"
                  placeholder="输入自定义回答"
                  aria-label={`${q.question} 自定义回答`}
                  value={otherText[index] ?? ""}
                  onChange={(e) => setOtherText((current) => ({ ...current, [index]: e.target.value }))}
                />
              )}
            </fieldset>
          );
        })}
        <div className="row">
          <button className="allow" type="submit" disabled={!complete}>提交回答</button>
        </div>
      </form>
    </div>
  );
}
