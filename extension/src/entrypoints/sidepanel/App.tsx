import React, { useEffect, useRef, useState } from "react";
import { BridgeClient, type ConnState } from "../../lib/ws-client";
import { loadSettings, saveSettings, pushFolderHistory, takePendingQuote, loadRuntimeCache, saveRuntimeCache, clearRuntimeCache, type ExtSettings, type RuntimeCache } from "../../lib/storage";
import { decideAttach, composeMessage, type PageSnapshot } from "../../lib/attach-policy";
import { snapshotActiveTab } from "../../lib/page-extract";
import type { ServerMessage, PermissionModeSetting, SessionInfo, AliasInfo } from "../../lib/protocol";
import type { PairingInfo } from "../../lib/pairing";
import { TokenGate } from "../../components/TokenGate";
import { AliasBar } from "../../components/AliasBar";
import { MessageList, type UiMsg } from "../../components/MessageList";
import { InputBox } from "../../components/InputBox";
import { shortModelName } from "../../lib/format";
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
  const [runtime, setRuntime] = useState<RuntimeCache>({}); // 桥接上报的实际生效模型/effort（chat.done 携带，本地缓存跨重载）
  const [forceAttach, setForceAttach] = useState(false); // 本次强制看页面（下一条消息强制附带全文；compact 后自动续一轮）
  const [sessions, setSessions] = useState<SessionInfo[]>([]); // 当前文件夹下的会话列表（切换会话下拉）
  const [showGate, setShowGate] = useState(false); // 手动打开重新配对界面（中途改端口/换桥接）
  const [aliases, setAliases] = useState<AliasInfo[]>([]); // 桥接别名列表（alias.list.data 推送）
  const [currentAliasId, setCurrentAliasId] = useState<string | null>(null); // 当前进行中的别名
  const pickResolverRef = useRef<((p: string | null) => void) | null>(null); // folder.picked 的等待者（folder.pick 请求-响应配对）
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
      case "alias.list.data":
        setAliases(m.aliases);
        setCurrentAliasId(m.currentId);
        break;
      case "folder.picked":
        pickResolverRef.current?.(m.path); // 配对到等待中的 folder.pick 请求
        pickResolverRef.current = null;
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
        if (typeof m.model === "string" && m.model.length > 0) {
          // 桥接上报实际生效的模型/effort：更新指示并落缓存（重载扩展后首轮回复前也有真值可显示）
          const rt: RuntimeCache = { model: m.model, ...(m.effort !== undefined ? { effort: m.effort } : {}) };
          setRuntime(rt);
          void saveRuntimeCache(rt);
        }
        setForceAttach(m.compacted === true); // compact 后下一轮强制带页面（上下文里的页面内容已被压缩掉）
        setStreaming((s) => {
          if (s) setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: s }]);
          return null;
        });
        break;
      case "chat.error":
        setStreaming(null);
        setForceAttach(false); // 本轮异常结束：强制附带随之失效
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
      getUrl: () => `ws://${s.host}:${s.port}/ws?token=${encodeURIComponent(s.token)}`,
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
      setRuntime(await loadRuntimeCache()); // 上次会话的实际生效模型/effort（首轮回复前的占位真值）
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
      clientRef.current?.send({ type: "alias.list" }); // 顺带拉取桥接别名列表
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

  /** 请求桥接弹系统文件夹选择框；folder.picked 到达时兑现（取消为 null） */
  function handlePickFolder(): Promise<string | null> {
    return new Promise((resolve) => {
      pickResolverRef.current = resolve;
      clientRef.current?.send({ type: "folder.pick" });
    });
  }

  async function handleSend(text: string): Promise<void> {
    const s = settingsRef.current;
    if (!s || !bound) return;
    let page: PageSnapshot | null = null;
    let attachFull = false;
    let attachNote: string | null = null;
    const force = forceAttach; // 本次强制看页面：无视附带开关与同页去重
    if (s.attachEnabled || force) {
      const snap = await snapshotActiveTab();
      if (snap.page && (snap.page.markdown || snap.page.selection)) page = snap.page; // 无内容则不带
      if (page) {
        const d = decideAttach(lastUrlRef.current, page.url, true);
        attachFull = force || d.attachFull;
        if (attachFull) lastUrlRef.current = page.url;
      }
      // 附带结果可见化：绝不允许静默降级
      attachNote = !page
        ? `⚠️ 未能附带页面：${snap.error ?? "页面无正文且无选中文字"}（本次仅发送问题）`
        : force && page.markdown
          ? `📄 已强制附带页面《${page.title}》正文 ${page.markdown.length} 字符`
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

  /** 重新配对：保存新连接参数、清掉旧桥的界面状态并重连（conn-open 效应会自动回绑 lastFolder） */
  async function handlePair(info: PairingInfo): Promise<void> {
    await saveSettings({ token: info.t, port: info.p, host: info.h });
    const s = await loadSettings();
    setAuthError("");
    setShowGate(false);
    setSettings(s);
    // 换桥 = 换世界：清掉旧桥留下的界面状态，由新桥的 folder.bound/history 重建
    prevFolderRef.current = null;
    prevBoundSidRef.current = null;
    setBound(null);
    setMessages([]);
    setStreaming(null);
    setSessions([]);
    setAliases([]);
    setCurrentAliasId(null); // 换桥：旧桥别名作废，等新桥 alias.list.data 重建
    setSessionId(null);
    setRuntime({}); // 新桥的实际生效值未知，连缓存一起清，等首轮 chat.done 重建
    void clearRuntimeCache();
    connect(s);
  }

  if (!settings) return <div className="loading">加载中…</div>;
  if (showGate || !settings.token || authError) {
    return (
      <TokenGate
        error={authError}
        onCancel={settings.token ? () => setShowGate(false) : undefined}
        onSave={(info) => void handlePair(info)}
      />
    );
  }

  return (
    <div className="app">
      <div className={`conn ${conn}`}>
        <span>{conn === "open" ? "● 已连接" : conn === "connecting" ? "● 连接中…" : "● 已断开（自动重连中）"}</span>
        <button className="pair-btn" title="重新配对（改端口 / 换桥接）" onClick={() => setShowGate(true)}>⚙ 配对</button>
      </div>
      <AliasBar
        aliases={aliases}
        currentAliasId={currentAliasId}
        history={settings.folderHistory}
        bound={bound}
        resumed={resumed}
        sessionId={sessionId}
        sessions={sessions}
        onAliasSelect={(id) => clientRef.current?.send({ type: "alias.select", id })}
        onAliasCreate={(name, folder, sid) => clientRef.current?.send({ type: "alias.create", name, folder, sessionId: sid })}
        onAliasDelete={(id) => clientRef.current?.send({ type: "alias.delete", id })}
        onPickFolder={handlePickFolder}
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
        effectiveModel={runtime.model ? shortModelName(runtime.model) : undefined}
        effectiveEffort={runtime.effort ?? undefined}
        forceAttach={forceAttach}
        onToggleForceAttach={() => setForceAttach((v) => !v)}
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
