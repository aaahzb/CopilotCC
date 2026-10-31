import React, { useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { isWebHref } from "../lib/format";
import type { InteractionRecord, ToolExecutionStatus } from "../lib/protocol";
import { InteractionRecordView } from "./InteractionRecordView";

/** 界面消息：user/assistant 聊天气泡；tool 为工具活动行或附带状态行 */
export interface UiMsg {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** 实际发送给 Claude 的完整文本（含页面上下文/上传说明），仅用户消息与附带状态行有 */
  sentText?: string;
  /** 实际工具调用的原始名称；附带状态行没有此字段，保持原 clickable 分支 */
  toolName?: string;
  /** 附带标记：full=页面全文，selection=选中文字，upload=上传文件；无标记=未附带 */
  attachKind?: "full" | "selection" | "upload";
  /** 已解决的提问/审批/计划记录；优先于普通工具行渲染 */
  interaction?: InteractionRecord;
  /** 工具调用与结果共用 toolUseId；完整详情折叠展示，不截断 */
  toolUseId?: string;
  toolStatus?: ToolExecutionStatus;
  toolInput?: string;
  toolOutput?: string;
  /** 只读状态的完整原因/用量；默认折叠展示，不用摘要代替全文 */
  detail?: string;
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

/**
 * 链接渲染：仅 http/https 绝对地址可点击（新标签打开，不顶替侧栏自身）。
 * 其余一律降级为带说明悬浮提示的纯文本：相对地址（如 Claude 写的 [标准知识.md](标准知识.md)）
 * 会按侧栏页面基地址解析成 chrome-extension://…/sidepanel.html 之类的错误地址，没有可打开的目标。
 */
function MdLink(props: { href?: string; children?: React.ReactNode }): React.ReactElement {
  const href = props.href ?? "";
  if (isWebHref(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {props.children}
      </a>
    );
  }
  return (
    <span className="dead-link" title={href ? `非网页地址（${href}），侧栏内无法打开，按纯文本显示` : undefined}>
      {props.children}
    </span>
  );
}

/** 常见工具与 MCP 语义回退的跨平台图标；未知工具保留通用扳手。 */
function toolIcon(name: string): string {
  const normalized = name.toLowerCase();
  const icons: Record<string, string> = {
    websearch: "🔍", webfetch: "🌐", read: "📄", edit: "✏️", multiedit: "✏️",
    write: "📝", bash: "💻", grep: "🔎", glob: "📁", upload: "📁",
  };
  if (icons[normalized]) return icons[normalized];
  if (normalized.startsWith("mcp__")) {
    if (normalized.includes("search")) return "🔍";
    if (["fetch", "crawl", "extract", "map"].some((part) => normalized.includes(part))) return "🌐";
  }
  return "🔧";
}

const TOOL_STATUS_TEXT: Record<ToolExecutionStatus, string> = {
  running: "执行中",
  success: "已完成",
  error: "失败",
  unknown: "未见结果",
};

/** 工具活动与结果：状态直接显示，完整参数和输出保留在可展开详情中。 */
function ToolActivity(props: {
  name: string;
  summary: string;
  status?: ToolExecutionStatus;
  input?: string;
  output?: string;
}): React.ReactElement {
  const title = props.summary ? `${props.name}: ${props.summary}` : props.name;
  return (
    <div className={`tool-card tool-activity${props.status ? ` ${props.status}` : ""}`} data-tool={props.name} title={title}>
      <div className="tool-heading">
        <span className="tool-icon" aria-hidden="true">{toolIcon(props.name)}</span>
        <span className="tool-name">{props.name}</span>
        {props.summary ? <span className="tool-summary">{props.summary}</span> : null}
        {props.status ? <span className="tool-status">{TOOL_STATUS_TEXT[props.status]}</span> : null}
      </div>
      {props.input !== undefined ? <details className="tool-detail"><summary>完整参数</summary><pre>{props.input}</pre></details> : null}
      {props.output !== undefined ? (
        <details className={`tool-detail${props.status === "error" ? " tool-error" : ""}`} open={props.status === "error"}>
          <summary>{props.status === "error" ? "错误详情" : "完整输出"}</summary>
          <pre>{props.output || "（无输出）"}</pre>
        </details>
      ) : null}
    </div>
  );
}
/** react-markdown 渲染配置：GFM + 数学公式 + 语法高亮 + 代码块复制按钮 + 非网页链接降级纯文本（MdLink） */
const MD = {
  remarkPlugins: [remarkGfm, remarkMath],
  rehypePlugins: [rehypeKatex, rehypeHighlight],
  components: { pre: CodeBlock, a: MdLink },
};

/** 距底超过该像素值时显示"回到底部"按钮 */
const BOTTOM_THRESHOLD = 120;

/**
 * 消息列表。用户气泡支持附带角标（📄全文/📎选中/📁上传）与右键查看实际发送内容；
 * 附带状态行点击弹浮层；滚动离开底部时出现回到底部按钮。
 * @param props.messages 已落地的消息列表
 * @param props.streaming 正在流式生成、尚未落地的 assistant 文本
 * @returns 消息列表 React 元素
 */
export function MessageList(props: {
  messages: UiMsg[];
  streaming: string | null;
  hasOlderHistory?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}): React.ReactElement {
  const [viewing, setViewing] = useState<UiMsg | null>(null); // 浮层查看中的消息
  const [showBottom, setShowBottom] = useState(false); // 是否显示回到底部按钮
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true); // 跟随模式：钉在底部随新内容/流式滚动；用户上滚离底即退出
  const prevUserCountRef = useRef(0); // 上次渲染的用户消息数（识别"我刚发送了一条"）
  const prevFirstIdRef = useRef<string | null>(null);
  const prevLastIdRef = useRef<string | null>(null);
  const historyAnchorRef = useRef<{ height: number; top: number } | null>(null);

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
  // 前插历史单独恢复锚点，不能把旧用户气泡误当“刚发送”而拉到底部。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const firstId = props.messages[0]?.id ?? null;
    const lastId = props.messages[props.messages.length - 1]?.id ?? null;
    const prepended = historyAnchorRef.current !== null && prevFirstIdRef.current !== null
      && firstId !== prevFirstIdRef.current && lastId === prevLastIdRef.current;
    const userCount = props.messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);
    if (!prepended && userCount > prevUserCountRef.current) followRef.current = true;
    prevUserCountRef.current = userCount;
    if (prepended && historyAnchorRef.current) {
      const anchor = historyAnchorRef.current;
      historyAnchorRef.current = null;
      el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
      setShowBottom(!atBottom(el));
    } else {
      if (followRef.current) el.scrollTop = el.scrollHeight; // 直接赋值贴底（smooth 动画追不上流式增量）
      else setShowBottom(!atBottom(el));
    }
    prevFirstIdRef.current = firstId;
    prevLastIdRef.current = lastId;
  }, [props.messages, props.streaming]);

  /** 加载更早页前记录视口锚点；新页前插后按内容高度差还原。 */
  function loadOlder(): void {
    const el = listRef.current;
    if (el) historyAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    props.onLoadOlder?.();
  }

  /** 回到底部：平滑滚到底；落地后由 onScroll 恢复跟随，流式继续时持续贴底 */
  function scrollToBottom(): void {
    setShowBottom(false);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="message-wrap">
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {props.hasOlderHistory ? (
          <button className="history-more" disabled={props.loadingOlder} onClick={loadOlder}>
            {props.loadingOlder ? "正在加载…" : "加载更早记录"}
          </button>
        ) : null}
        {props.messages.map((m) =>
          m.role === "tool" ? (
            m.interaction ? (
              <InteractionRecordView key={m.id} record={m.interaction} />
            ) : m.toolName ? (
              <ToolActivity
                key={m.id}
                name={m.toolName}
                summary={m.text}
                status={m.toolStatus}
                input={m.toolInput}
                output={m.toolOutput}
              />
            ) : m.sentText ? (
              // 附带状态行：平时一行折叠态，点击弹出临时浮层查看完整发送内容，关闭即消失
              <div key={m.id} className="tool-card clickable" title="点击查看实际发送内容" onClick={() => setViewing(m)}>
                {m.text} 🔍
              </div>
            ) : (
              <div key={m.id} className="tool-card">
                {m.text}
                {m.detail !== undefined ? (
                  <details className="status-detail">
                    <summary>技术详情</summary>
                    <pre>{m.detail}</pre>
                  </details>
                ) : null}
              </div>
            )
          ) : (
            <div
              key={m.id}
              className={`msg ${m.role}`}
              title={m.sentText ? "右键查看实际发送内容" : undefined}
              onContextMenu={m.sentText ? (e) => { e.preventDefault(); setViewing(m); } : undefined}
            >
              {m.attachKind ? (
                <span
                  className="attach-mark"
                  title={m.attachKind === "full" ? "已附带页面全文" : m.attachKind === "selection" ? "已附带选中文字" : "已上传文件到 copilotUploads"}
                >
                  {m.attachKind === "full" ? "📄" : m.attachKind === "selection" ? "📎" : "📁"}
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
