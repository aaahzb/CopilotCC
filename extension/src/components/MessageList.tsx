import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";

/** 界面消息：user/assistant 聊天气泡，tool 为折叠工具卡片 */
export interface UiMsg {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** 实际发送给 Claude 的完整文本（含页面上下文），仅用户消息与附带状态行有 */
  sentText?: string;
  /** 附带标记：full=页面全文，selection=选中文字；无标记=未附带 */
  attachKind?: "full" | "selection";
}

/**
 * 代码块容器：相对定位 + 右上角复制按钮。
 * react-markdown 会把 <pre> 渲染委派到这里。
 * @param props.children 代码内容（react-markdown 传入的 <code> 元素）
 * @returns 带复制按钮的代码块
 */
function CodeBlock(props: { children?: React.ReactNode }): React.ReactElement {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-wrap">
      <button
        className="code-copy"
        onClick={() => {
          const text = ref.current?.innerText ?? "";
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={ref}>{props.children}</pre>
    </div>
  );
}

/** react-markdown 渲染配置：GFM + 数学公式 + 语法高亮 + 代码块复制按钮 */
const MD = {
  remarkPlugins: [remarkGfm, remarkMath],
  rehypePlugins: [rehypeKatex, rehypeHighlight],
  components: { pre: CodeBlock },
};

/** 距底超过该像素值时显示"回到底部"按钮 */
const BOTTOM_THRESHOLD = 120;

/**
 * 消息列表。用户气泡支持附带角标（📄全文/📎选中）与右键查看实际发送内容；
 * 附带状态行点击弹浮层；滚动离开底部时出现回到底部按钮。
 * @param props.messages 已落地的消息列表
 * @param props.streaming 正在流式生成、尚未落地的 assistant 文本
 * @returns 消息列表 React 元素
 */
export function MessageList(props: { messages: UiMsg[]; streaming: string | null }): React.ReactElement {
  const [viewing, setViewing] = useState<UiMsg | null>(null); // 浮层查看中的消息
  const [showBottom, setShowBottom] = useState(false); // 是否显示回到底部按钮
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true); // 跟随模式：钉在底部随新内容/流式滚动；用户上滚离底即退出
  const prevUserCountRef = useRef(0); // 上次渲染的用户消息数（识别"我刚发送了一条"）

  /** 距底在阈值内视为"在底部" */
  function atBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
  }

  /** 滚动监听：在底部=进入跟随并藏按钮；离底=退出跟随并显示按钮（用户主动上滚看历史） */
  function onScroll(): void {
    const el = listRef.current;
    if (!el) return;
    const b = atBottom(el);
    followRef.current = b;
    setShowBottom(!b);
  }

  // 新内容（落地消息或流式增量）到达时：跟随中→即时贴底；非跟随→重估按钮。
  // 内容增长本身不触发 scroll 事件，所以流式第一个字到达时若用户在看历史，这里让按钮立即出现。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const userCount = props.messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);
    if (userCount > prevUserCountRef.current) followRef.current = true; // 我刚发送（或历史回放整批落地）：强制跟随
    prevUserCountRef.current = userCount;
    if (followRef.current) el.scrollTop = el.scrollHeight; // 直接赋值贴底（smooth 动画追不上流式增量）
    else setShowBottom(!atBottom(el));
  }, [props.messages, props.streaming]);

  /** 回到底部：平滑滚到底；落地后由 onScroll 恢复跟随，流式继续时持续贴底 */
  function scrollToBottom(): void {
    setShowBottom(false);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="message-wrap">
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {props.messages.map((m) =>
          m.role === "tool" ? (
            m.sentText ? (
              // 附带状态行：平时一行折叠态，点击弹出临时浮层查看完整发送内容，关闭即消失
              <div key={m.id} className="tool-card clickable" title="点击查看实际发送内容" onClick={() => setViewing(m)}>
                {m.text} 🔍
              </div>
            ) : (
              <div key={m.id} className="tool-card">{m.text}</div>
            )
          ) : (
            <div
              key={m.id}
              className={`msg ${m.role}`}
              title={m.sentText ? "右键查看实际发送内容" : undefined}
              onContextMenu={m.sentText ? (e) => { e.preventDefault(); setViewing(m); } : undefined}
            >
              {m.attachKind ? (
                <span className="attach-mark" title={m.attachKind === "full" ? "已附带页面全文" : "已附带选中文字"}>
                  {m.attachKind === "full" ? "📄" : "📎"}
                </span>
              ) : null}
              <ReactMarkdown {...MD}>{m.text}</ReactMarkdown>
            </div>
          ),
        )}
        {props.streaming !== null ? (
          <div className="msg assistant streaming">
            <ReactMarkdown {...MD}>{props.streaming}</ReactMarkdown>
          </div>
        ) : null}
      </div>
      {showBottom ? (
        <button className="scroll-bottom" onClick={scrollToBottom}>⬇ 回到底部</button>
      ) : null}
      {viewing ? (
        <div className="sent-viewer" onClick={() => setViewing(null)}>
          <div className="sent-viewer-box" onClick={(e) => e.stopPropagation()}>
            <div className="sent-viewer-head">
              <span>实际发送给 Claude 的完整内容</span>
              <button onClick={() => void navigator.clipboard.writeText(viewing.sentText ?? viewing.text)}>复制</button>
              <button onClick={() => setViewing(null)}>关闭</button>
            </div>
            <pre>{viewing.sentText ?? viewing.text}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
