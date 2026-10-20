import React, { useEffect, useRef, useState } from "react";
import { BridgeClient, type ConnState } from "../../lib/ws-client";
import { loadSettings, saveSettings, pushFolderHistory, takePendingQuote, type ExtSettings } from "../../lib/storage";
import { decideAttach, composeMessage, type PageSnapshot } from "../../lib/attach-policy";
import { snapshotActiveTab } from "../../lib/page-extract";
import type { ServerMessage, PermissionModeSetting, SessionInfo } from "../../lib/protocol";
import { TokenGate } from "../../components/TokenGate";
import { FolderBar } from "../../components/FolderBar";
import { MessageList, type UiMsg } from "../../components/MessageList";
import { InputBox } from "../../components/InputBox";
import { PermissionCard } from "../../components/PermissionCard";

/** 侧栏主界面 */
export default function App(): React.ReactElement {
  const [settings, setSettings] = useState<ExtSettings | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [authError, setAuthError] = useState("");
  const [bound, setBound] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [permReq, setPermReq] = useState<{ requestId: string; tool: string; detail: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null); // 当前会话 ID（folder.bound/session.list.data 携带或 chat.done 推送）
  const [sessions, setSessions] = useState<SessionInfo[]>([]); // 当前文件夹下的会话列表（切换会话下拉）
  const clientRef = useRef<BridgeClient | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  const prevFolderRef = useRef<string | null>(null); // 上次绑定的文件夹（识别"切换文件夹"）
  const prevBoundSidRef = useRef<string | null>(null); // 上次 folder.bound/chat.done 的会话 ID（识别"切换会话"）
  const settingsRef = useRef<ExtSettings | null>(null);
  settingsRef.current = settings;

  /** 处理桥接消息 */
  function onServerMessage(m: ServerMessage): void {
    switch (m.type) {
      case "auth.ok":
        clientRef.current?.send({ type: "client.ready" });
        break;
      case "auth.fail":
        setAuthError(m.reason);
        break;
      case "folder.bound":
        if (
          (prevFolderRef.current !== null && prevFolderRef.current !== m.path) ||
          (prevBoundSidRef.current !== null && prevBoundSidRef.current !== m.sessionId)
        ) {
          // 换文件夹或换会话：清空当前显示（含流式残留），历史回放随后覆盖
          setMessages([]);
          setStreaming(null);
        }
        prevFolderRef.current = m.path;
        prevBoundSidRef.current = m.sessionId;
        setBound(m.path);
        setResumed(m.resumed);
        setSessionId(m.sessionId);
        lastUrlRef.current = null; // 换文件夹/会话后重新附带全文
        if (m.resumed) clientRef.current?.send({ type: "session.history" });
        break;
      case "folder.error":
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${m.message}` }]);
        break;
      case "session.history.data":
        // 回放消息带 sentText/attachKind：重载前后显示行为一致（气泡只显示问题，完整发送内容右键可溯源）
        setMessages(m.messages.map((h) => ({ id: crypto.randomUUID(), role: h.role, text: h.text, sentText: h.sentText, attachKind: h.attachKind })));
        break;
      case "session.list.data":
        setSessions(m.sessions);
        setSessionId(m.currentId);
        prevBoundSidRef.current = m.currentId;
        break;
      case "chat.delta":
        setStreaming((s) => (s ?? "") + m.text);
        break;
      case "chat.tool":
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "tool", text: `🔧 ${m.name} ${m.summary}` }]);
        break;
      case "chat.done":
        setSessionId(m.sessionId);
        prevBoundSidRef.current = m.sessionId;
        setStreaming((s) => {
          if (s) setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: s }]);
          return null;
        });
        break;
      case "chat.error":
        setStreaming(null);
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${m.message}` }]);
        break;
      case "permission.request":
        setPermReq({ requestId: m.requestId, tool: m.tool, detail: m.detail });
        break;
    }
  }

  /** 建立（或重建）WS 连接 */
  function connect(s: ExtSettings): void {
    clientRef.current?.close();
    const c = new BridgeClient({
      getUrl: () => `ws://127.0.0.1:${s.port}/ws?token=${s.token}`,
      onMessage: onServerMessage,
      onState: setConn,
    });
    clientRef.current = c;
    c.connect();
  }

  useEffect(() => {
    void (async () => {
      const s = await loadSettings();
      setSettings(s);
      if (s.token) connect(s);
      // 右键菜单带入的选中文字：预填一条引用消息
      const quote = await takePendingQuote();
      if (quote) {
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "user", text: `(引用选中内容)\n> ${quote}` }]);
      }
    })();
    return () => clientRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每次 WS 进入 open（含断线重连）都回绑：服务端每条连接的状态独立，
  // 重连后不重绑会出现客户端显示已绑定、服务端却报"请先绑定文件夹"
  useEffect(() => {
    if (conn === "open") {
      const p = bound ?? settings?.lastFolder;
      if (p) clientRef.current?.send({ type: "folder.bind", path: p });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  async function handleBind(p: string): Promise<void> {
    if (!p.trim()) return;
    await pushFolderHistory(p.trim());
    setSettings(await loadSettings());
    setBound(null);
    clientRef.current?.send({ type: "folder.bind", path: p.trim() });
  }

  async function handleSend(text: string): Promise<void> {
    const s = settingsRef.current;
    if (!s || !bound) return;
    let page: PageSnapshot | null = null;
    let attachFull = false;
    let attachNote: string | null = null;
    if (s.attachEnabled) {
      const snap = await snapshotActiveTab();
      if (snap.page && (snap.page.markdown || snap.page.selection)) page = snap.page; // 无内容则不带
      if (page) {
        const d = decideAttach(lastUrlRef.current, page.url, true);
        attachFull = d.attachFull;
        if (d.attachFull) lastUrlRef.current = page.url;
      }
      // 附带结果可见化：绝不允许静默降级
      attachNote = !page
        ? `⚠️ 未能附带页面：${snap.error ?? "页面无正文且无选中文字"}（本次仅发送问题）`
        : attachFull && page.markdown
          ? `📄 已附带页面《${page.title}》正文 ${page.markdown.length} 字符`
          : page.selection
            ? `📎 已附带选中文字${attachFull && !page.markdown ? `（正文提取失败${snap.error ? `：${snap.error}` : ""}）` : "（页面全文已在会话上下文）"}`
            : "ℹ️ 同页追问：未重复附带全文（此前已进会话上下文）";
    }
    const full = composeMessage(text, page, attachFull);
    // 附带标记：📄 全文 / 📎 仅选中文字；未附带则无标记
    const attachKind: UiMsg["attachKind"] = !page
      ? undefined
      : attachFull && page.markdown
        ? "full"
        : page.selection
          ? "selection"
          : undefined;
    setMessages((ms) => {
      const next: UiMsg[] = [...ms, { id: crypto.randomUUID(), role: "user", text, sentText: full, attachKind }];
      if (attachNote) next.push({ id: crypto.randomUUID(), role: "tool", text: attachNote, sentText: full });
      return next;
    });
    clientRef.current?.send({ type: "chat.send", text: full });
  }

  /** 更新设置并把权限模式/模型/effort 全量推给桥接（任一变化桥接都会重建会话） */
  async function applySettings(patch: Partial<ExtSettings>): Promise<void> {
    await saveSettings(patch);
    const s = await loadSettings();
    setSettings(s);
    clientRef.current?.send({
      type: "settings.set",
      permissionMode: s.permissionMode,
      model: s.model || undefined,
      effort: s.effort || undefined,
    });
  }

  async function handleModeChange(m: PermissionModeSetting): Promise<void> {
    await applySettings({ permissionMode: m });
  }

  if (!settings) return <div className="loading">加载中…</div>;
  if (!settings.token || authError) {
    return (
      <TokenGate
        error={authError}
        onSave={async (token, port) => {
          await saveSettings({ token, port });
          const s = await loadSettings();
          setAuthError("");
          setSettings(s);
          connect(s);
        }}
      />
    );
  }

  return (
    <div className="app">
      <div className={`conn ${conn}`}>{conn === "open" ? "● 已连接" : conn === "connecting" ? "● 连接中…" : "● 已断开（自动重连中）"}</div>
      <FolderBar
        history={settings.folderHistory}
        bound={bound}
        resumed={resumed}
        sessionId={sessionId}
        sessions={sessions}
        onBind={handleBind}
        onNewSession={() => clientRef.current?.send({ type: "session.new" })}
        onSwitchSession={(id) => clientRef.current?.send({ type: "session.switch", sessionId: id })}
        onDeleteSession={(id) => clientRef.current?.send({ type: "session.delete", sessionId: id })}
      />
      <MessageList messages={messages} streaming={streaming} />
      <PermissionCard
        request={permReq}
        onRespond={(id, allow) => {
          clientRef.current?.send({ type: "permission.response", requestId: id, allow });
          setPermReq(null);
        }}
      />
      <InputBox
        disabled={!bound || conn !== "open"}
        streaming={streaming !== null}
        attachEnabled={settings.attachEnabled}
        permissionMode={settings.permissionMode}
        model={settings.model}
        effort={settings.effort}
        onToggleAttach={async (v) => { await saveSettings({ attachEnabled: v }); setSettings(await loadSettings()); }}
        onModeChange={handleModeChange}
        onModelChange={(v) => void applySettings({ model: v })}
        onEffortChange={(v) => void applySettings({ effort: v })}
        onSend={handleSend}
        onStop={() => clientRef.current?.send({ type: "chat.abort" })}
      />
    </div>
  );
}
