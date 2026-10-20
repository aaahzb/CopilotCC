import React, { useEffect, useRef, useState } from "react";
import { BridgeClient, type ConnState } from "../../lib/ws-client";
import { loadSettings, saveSettings, pushFolderHistory, takePendingQuote, type ExtSettings } from "../../lib/storage";
import { decideAttach, composeMessage, type PageSnapshot } from "../../lib/attach-policy";
import { snapshotActiveTab } from "../../lib/page-extract";
import type { ServerMessage, PermissionModeSetting } from "../../lib/protocol";
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
  const clientRef = useRef<BridgeClient | null>(null);
  const lastUrlRef = useRef<string | null>(null);
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
        setBound(m.path);
        setResumed(m.resumed);
        lastUrlRef.current = null; // 换文件夹后重新附带全文
        if (m.resumed) clientRef.current?.send({ type: "session.history" });
        break;
      case "folder.error":
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${m.message}` }]);
        break;
      case "session.history.data":
        setMessages(m.messages.map((h) => ({ id: crypto.randomUUID(), role: h.role, text: h.text })));
        break;
      case "chat.delta":
        setStreaming((s) => (s ?? "") + m.text);
        break;
      case "chat.tool":
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "tool", text: `🔧 ${m.name} ${m.summary}` }]);
        break;
      case "chat.done":
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

  // auth.ok 后自动回绑上次文件夹
  useEffect(() => {
    if (conn === "open" && settings?.lastFolder && !bound) {
      clientRef.current?.send({ type: "folder.bind", path: settings.lastFolder });
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
    setMessages((ms) => {
      const next: UiMsg[] = [...ms, { id: crypto.randomUUID(), role: "user", text }];
      if (attachNote) next.push({ id: crypto.randomUUID(), role: "tool", text: attachNote });
      return next;
    });
    clientRef.current?.send({ type: "chat.send", text: full });
  }

  async function handleModeChange(m: PermissionModeSetting): Promise<void> {
    await saveSettings({ permissionMode: m });
    setSettings(await loadSettings());
    clientRef.current?.send({ type: "settings.set", permissionMode: m });
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
      <FolderBar history={settings.folderHistory} bound={bound} resumed={resumed} onBind={handleBind} />
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
        onToggleAttach={async (v) => { await saveSettings({ attachEnabled: v }); setSettings(await loadSettings()); }}
        onModeChange={handleModeChange}
        onSend={handleSend}
        onStop={() => clientRef.current?.send({ type: "chat.abort" })}
      />
    </div>
  );
}
