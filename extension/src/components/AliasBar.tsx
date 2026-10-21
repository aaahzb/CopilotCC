import React, { useState } from "react";
import type { AliasInfo, PageRichness, SessionInfo } from "../lib/protocol";
import { FolderBar } from "./FolderBar";

/**
 * 别名栏：平时只显别名标签（一行：别名下拉 + 新建/删除/详情按钮）。
 * 文件夹+会话详情默认折叠，点「详情」展开（改绑定即改别名，粘性同步）。
 * 「＋新建」时才出现绑定框（别名+文件夹+会话），创建即切换；删别名不动会话。
 */
export function AliasBar(props: {
  aliases: AliasInfo[];
  currentAliasId: string | null;
  history: string[];
  bound: string | null;
  resumed: boolean;
  sessionId: string | null;
  sessions: SessionInfo[];
  onAliasSelect(id: string): void;
  onAliasCreate(name: string, folder: string, sessionId: string | null, pageRichness: PageRichness): void;
  /** 更新当前别名配置（页面丰富度；改文件夹/会话绑定仍走 folder.bind/session.switch） */
  onAliasUpdate(id: string, patch: { pageRichness?: PageRichness }): void;
  onAliasDelete(id: string): void;
  /** 弹系统文件夹选择框；用户取消返回 null */
  onPickFolder(): Promise<string | null>;
  onBind(path: string): void;
  onNewSession(): void;
  onSwitchSession(sessionId: string): void;
  onDeleteSession(sessionId: string): void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false); // 文件夹+会话详情区
  const [creating, setCreating] = useState(false); // 新建别名表单
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [sessionId, setSessionId] = useState(""); // "" = 新会话
  const [picking, setPicking] = useState(false);
  const [richness, setRichness] = useState<PageRichness>("standard"); // 新建表单的页面丰富度选择
    const [manualSid, setManualSid] = useState(false); // 手动输入会话 ID 模式（绑定外部会话的通道）
    const [sidInput, setSidInput] = useState("");
  const current = props.aliases.find((a) => a.id === props.currentAliasId) ?? null;

  /** 打开新建表单：预填当前绑定状态（未绑定时留空等用户选） */
  function startCreate(): void {
    setName("");
    setFolder(props.bound ?? "");
    setSessionId(props.sessionId ?? "");
    setManualSid(false); setSidInput(""); // 每次打开表单复位输入模式
    setRichness("standard"); // 丰富度复位默认档
    setExpanded(false); // 新建与详情互斥：表单自带文件夹+会话选择，避免两套控件重叠
    setCreating(true);
  }

  /** 弹系统选择框选文件夹，取消则不动 */
  async function browse(): Promise<void> {
    setPicking(true);
    try {
      const p = await props.onPickFolder();
      if (p) setFolder(p);
    } finally {
      setPicking(false);
    }
  }

  /** 提交创建：文件夹被改成非当前绑定路径时该文件夹的会话无从预知，固定开新会话 */
  function submit(): void {
    const f = folder.trim();
    if (!name.trim() || !f) return;
    const sid = manualSid ? sidInput.trim().replace(/^claude\s+--resume\s+/i, "").trim() || null : f === props.bound ? sessionId || null : null; // 手动模式容忍直接粘贴整行 resume 命令
    props.onAliasCreate(name.trim(), f, sid, richness);
    setCreating(false);
    setManualSid(false); setSidInput(""); // 提交后复位输入模式
  }

  /** 删除当前别名（只删别名，文件夹与会话记录全部保留） */
  function confirmDelete(): void {
    if (!current) return;
    if (window.confirm(`删除别名「${current.name}」？仅删除别名，文件夹与会话记录全部保留。`)) {
      props.onAliasDelete(current.id);
    }
  }

  /**
   * 会话下拉文案：标题 + 最后活跃时间（MM-DD HH:mm）。
   * @param s 会话项
   * @returns 展示文本
   */
  function sessionLabel(s: SessionInfo): string {
    const d = new Date(s.updatedAt);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${s.title}（${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}）`;
  }

  // 文件夹框仍是当前绑定路径时，会话下拉可选（否则该文件夹的会话列表无从预知）
  const folderIsBound = folder.trim() !== "" && folder.trim() === props.bound;
  const MANUAL = "__manual__"; // 会话下拉"手动输入 ID…"占位选项值

  return (
    <div className="alias-bar">
      <div className="alias-bar-row">
        <select
          className="alias-switch"
          title="选择进行中的别名"
          value={current?.id ?? ""}
          onChange={(e) => {
            if (e.target.value) props.onAliasSelect(e.target.value);
          }}
        >
          {props.aliases.length === 0 ? <option value="" disabled>（暂无别名，点＋新建）</option> : null}
          {props.aliases.length > 0 && !current ? <option value="" disabled>选择别名…</option> : null}
          {props.aliases.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button className="mini-btn" title="新建别名（绑定文件夹+会话）" onClick={startCreate}>＋新建</button>
        {current ? (
          <button className="mini-btn danger" title="删除当前别名（会话保留）" onClick={confirmDelete}>🗑</button>
        ) : null}
        <button
          className="mini-btn"
          title={expanded ? "收起文件夹+会话详情" : "展开文件夹+会话详情（改绑定即改当前别名）"}
          onClick={() => { setExpanded((v) => !v); setCreating(false); }} // 详情与新建互斥
        >
          {expanded ? "▾ 收起" : "▸ 详情"}
        </button>
      </div>
      {creating ? (
        <div className="alias-create">
          <input
            placeholder="别名，如：读书笔记"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <div className="alias-create-row">
            <input
              placeholder="文件夹绝对路径"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <button className="mini-btn" disabled={picking} onClick={() => void browse()}>
              {picking ? "选择中…" : "选择文件夹…"}
            </button>
          </div>
          <select
            value={manualSid ? MANUAL : folderIsBound ? sessionId : ""}
            title={folderIsBound ? "绑定该文件夹下的会话，或手动输入会话 ID" : "新文件夹：开新会话，或手动输入会话 ID 续聊"}
            onChange={(e) => {
              if (e.target.value === MANUAL) setManualSid(true);
              else { setManualSid(false); setSessionId(e.target.value); }
            }}
          >
            <option value="">＋新会话</option>
            {folderIsBound ? props.sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>{sessionLabel(s)}</option>
            )) : null}
            <option value={MANUAL}>手动输入 ID…</option>
          </select>
          {manualSid ? (
            <input
              placeholder="会话 ID（可直接粘贴 claude --resume 整行命令）"
              value={sidInput}
              onChange={(e) => setSidInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          ) : null}
          <select
            value={richness}
            title="页面信息丰富度：附带网页时注入正文的最大字符数（该别名每次提问生效）"
            onChange={(e) => setRichness(e.target.value as PageRichness)}
          >
            <option value="brief">页面丰富度：精简（约 5 千字）</option>
            <option value="standard">页面丰富度：标准（约 3 万字）</option>
            <option value="rich">页面丰富度：丰富（约 10 万字）</option>
          </select>
          <div className="alias-create-actions">
            <button className="primary" disabled={!name.trim() || !folder.trim()} onClick={submit}>创建并切换</button>
            <button className="mini-btn" onClick={() => setCreating(false)}>取消</button>
          </div>
        </div>
      ) : null}
      {expanded ? (
        <div className="alias-detail">
          <div className="richness-row" title="页面信息丰富度：附带网页时注入正文的最大字符数，按别名各自保存在桥接">
            <span>页面丰富度</span>
            <select
              value={current?.pageRichness ?? "standard"}
              disabled={!current}
              onChange={(e) => { if (current) props.onAliasUpdate(current.id, { pageRichness: e.target.value as PageRichness }); }}
            >
              <option value="brief">精简（约 5 千字）</option>
              <option value="standard">标准（约 3 万字）</option>
              <option value="rich">丰富（约 10 万字）</option>
            </select>
          </div>
          <FolderBar
            history={props.history}
            bound={props.bound}
            resumed={props.resumed}
            sessionId={props.sessionId}
            sessions={props.sessions}
            onBind={props.onBind}
            onNewSession={props.onNewSession}
            onSwitchSession={props.onSwitchSession}
            onDeleteSession={props.onDeleteSession}
          />
        </div>
      ) : null}
    </div>
  );
}
