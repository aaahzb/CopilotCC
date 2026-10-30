import React, { useEffect, useRef, useState } from "react";
import { BridgeClient, type ConnState } from "../../lib/ws-client";
import { loadSettings, saveSettings, pushFolderHistory, takePendingQuote, loadRuntimeCache, saveRuntimeCache, clearRuntimeCache, type ExtSettings, type RuntimeCache } from "../../lib/storage";
import { decideAttach, composeMessage, deriveAttachKind, PAGE_RICHNESS_CAPS, type PageSnapshot } from "../../lib/attach-policy";
import type { PendingUpload } from "../../lib/upload-files";
import { snapshotActiveTab, snapshotTab } from "../../lib/page-extract";
import type { ServerMessage, PermissionModeSetting, SessionInfo, AliasInfo } from "../../lib/protocol";
import type { PairingInfo } from "../../lib/pairing";
import { TokenGate } from "../../components/TokenGate";
import { AliasBar } from "../../components/AliasBar";
import { MessageList, type UiMsg } from "../../components/MessageList";
import { InputBox } from "../../components/InputBox";
import { shortModelName, compactRecordText } from "../../lib/format";
import { hasExecutionSettingsChange, mergeDoneRuntime, mirrorExecutionSettings, runtimeFromSettingsState, toFastSettingsSet, toSettingsSet, type ExecutionSettingsPatch } from "../../lib/settings-sync";
import { PermissionCard } from "../../components/PermissionCard";
import { shouldResetConversation } from "../../lib/conversation-state";

/**
 * 别名徽标/芯片色相：id 简单散列取 360 模（弹窗芯片与页面徽标同色，无需调色板）。
 * @param aliasId 别名 ID；null 用默认蓝
 * @returns 色相 0-359
 */
function aliasHue(aliasId: string | null): number {
  if (!aliasId) return 210;
  let h = 0;
  for (let i = 0; i < aliasId.length; i++) h = (h * 31 + aliasId.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * 聊天主界面（侧边栏与弹窗共用同一份镜像视图）。
 * 状态真源在桥接工作区：消息/流式/草稿/审批全部来自桥接广播与快照（client.ready → chat.sync），
 * 本组件不做乐观上屏（气泡一致性由桥接 chat.user 广播保证）。
 * popupTabId 非空即弹窗模式：页面提取钉住该 tab（弹窗聚焦时"活动 tab"是弹窗自己），
 * 顶栏提供 📌 关联芯片 / 🎯 指向当前页（换绑）/ ⇱ 回侧边栏。
 */
export default function App(props: { popupTabId?: number | null; popupAliasId?: string | null }): React.ReactElement {
  const popupTabId = props.popupTabId ?? null; // 非 null = 弹窗模式（钉住的页面 tab）
  const popupAliasId = props.popupAliasId ?? null; // 弹窗打开时指定要选中的别名
  const [settings, setSettings] = useState<ExtSettings | null>(null);
  const [settingsError, setSettingsError] = useState(""); // 原生设置应用失败：只提示设置区，不终结聊天轮次
  const [conn, setConn] = useState<ConnState>("connecting");
  const [compactSince, setCompactSince] = useState<number | null>(null); // 压缩开始时刻；null=未在压缩
  const [compactTick, setCompactTick] = useState(0); // 每秒 +1 触发重渲染以刷新秒数
  useEffect(() => {
    if (compactSince === null) return;
    const timer = window.setInterval(() => setCompactTick((v) => v + 1), 1000);
    return () => window.clearInterval(timer);
  }, [compactSince]);
  void compactTick; // 秒数显示依赖它触发重算
  const [authError, setAuthError] = useState("");
  const [bound, setBound] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // 一轮生成进行中（chat.user 起，done/error/aborted/断线/换会话止）：发送键变为停止键
  const [permReq, setPermReq] = useState<{ requestId: string; tool: string; detail: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null); // 当前会话 ID（folder.bound/session.list.data 携带或 chat.done 推送）
  const [runtime, setRuntime] = useState<RuntimeCache>({}); // CC 回报的实际模型/effort/fast；与请求设置分离并跨重载缓存
  const [forceAttach, setForceAttach] = useState(false); // 本次强制看页面（下一条消息强制附带全文；compact 后自动续一轮）
  const [sessions, setSessions] = useState<SessionInfo[]>([]); // 当前文件夹下的会话列表（切换会话下拉）
  const [showGate, setShowGate] = useState(false); // 手动打开重新配对界面（中途改端口/换桥接）
  const [aliases, setAliases] = useState<AliasInfo[]>([]); // 桥接别名列表（alias.list.data 推送）
  const [currentAliasId, setCurrentAliasId] = useState<string | null>(null); // 当前进行中的别名
  const [draft, setDraft] = useState(""); // 输入框草稿（工作区镜像：本地即显 + 防抖上报，桥接广播其它视图）
  const [pinTabId, setPinTabId] = useState<number | null>(popupTabId); // 弹窗钉住的页面 tab（🎯 换绑会改）
  const [pinTabTitle, setPinTabTitle] = useState(""); // 钉住页标题（顶栏芯片显示）
  const [pinTabUrl, setPinTabUrl] = useState(""); // 钉住页地址（芯片悬浮提示）
  const [pinWinId, setPinWinId] = useState<number | null>(null); // 弹窗自身的窗口 ID（pin.report/聚焦用）
  const [openFolderFlash, setOpenFolderFlash] = useState<string | null>(null); // folder.opened 瞬时反馈（约 4 秒）
  const pickResolverRef = useRef<((p: string | null) => void) | null>(null); // folder.picked 的等待者（folder.pick 请求-响应配对）
  const clientRef = useRef<BridgeClient | null>(null);
  const lastUrlRef = useRef<string | null>(null);
  const prevFolderRef = useRef<string | null>(null); // 上次绑定的文件夹（识别"切换文件夹"）
  const prevBoundSidRef = useRef<string | null>(null); // 上次 folder.bound/chat.done 的会话 ID（识别"切换会话"）
  const snapshotPhaseRef = useRef(false); // 快照窗口期（auth.ok → chat.sync）：此间的 folder.bound 不再回讨 history（快照自带）
  const snapshotBoundRef = useRef(false); // 本次连接的快照是否已含绑定（chat.sync 据此决定要不要回绑 lastFolder）
  const composingRef = useRef(false); // 输入法组合中：chat.draft 入包不顶字，防抖上报也暂缓
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 草稿防抖定时器
  const flashTimerRef = useRef<number | null>(null); // 打开文件夹反馈的清除定时器
  const aliasSelectTriedRef = useRef(false); // 弹窗 URL 指定别名的自动选中只试一次
  const settingsRef = useRef<ExtSettings | null>(null);
  settingsRef.current = settings;
  const runtimeRef = useRef<RuntimeCache>({}); // 长寿命 WS 回调读取最近真值，避免闭包停在首轮空缓存
  runtimeRef.current = runtime;

  /** 同步更新 ref、界面和持久缓存；调用方决定是完整替换还是缺字段合并 */
  function commitRuntime(next: RuntimeCache): void {
    runtimeRef.current = next;
    setRuntime(next);
    void saveRuntimeCache(next);
  }

  /** 处理桥接消息 */
  function onServerMessage(m: ServerMessage): void {
    switch (m.type) {
      case "auth.ok":
        snapshotPhaseRef.current = true; // 进入快照窗口期
        snapshotBoundRef.current = false;
        // 完整设置 + client.ready 由 BridgeClient 在本回调返回后按序补发：先同步模型，再恢复快照/会话
        break;
      case "auth.fail":
        setAuthError(m.reason);
        break;
      case "folder.bound":
        snapshotBoundRef.current = true; // 快照已含绑定（或非快照期的主动绑定，置位无害）
        if (shouldResetConversation(m, prevFolderRef.current, prevBoundSidRef.current)) {
          // 主动 reset 或换绑：清消息、流式、busy 与运行时缓存
          setMessages([]);
          setStreaming(null);
          setBusy(false); // 旧会话的进行轮随切换作废，其收尾帧不再属于当前界面
          setCompactSince(null); // 旧会话的压缩提示一并清除
          commitRuntime({}); // 主动换文件夹/会话后旧实际值失效；初次快照不在此清缓存
        }
        prevFolderRef.current = m.path;
        prevBoundSidRef.current = m.sessionId;
        setBound(m.path);
        setResumed(m.resumed);
        setSessionId(m.sessionId);
        lastUrlRef.current = null; // 换文件夹/会话后重新附带全文
        // 快照窗口期内不回讨 history：快照按序自带 history（重复回讨会在 chat.sync 后到达，抹掉在途气泡）
        if (m.resumed && !snapshotPhaseRef.current) clientRef.current?.send({ type: "session.history" });
        break;
      case "folder.error":
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${m.message}` }]);
        break;
      case "session.history.data":
        // 回放消息带 sentText/attachKind：重载前后显示行为一致（气泡只显示问题，完整发送内容右键可溯源）
        setMessages(m.messages.map((h) => ({
          id: crypto.randomUUID(),
          role: h.role,
          toolName: h.toolName, // 历史工具与实时 chat.tool 共用同一活动行渲染
          text: h.text,
          sentText: h.sentText,
          attachKind: h.attachKind,
        })));
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
      case "folder.opened": {
        // 打开文件夹的瞬时反馈（AliasBar 按钮旁显示约 4 秒）
        const text = m.script ? `已打开（续聊脚本：${m.script}）` : "已打开";
        setOpenFolderFlash(text);
        if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => setOpenFolderFlash(null), 4000);
        break;
      }
      case "chat.user": {
        // 回显上屏（广播，含发送方）：气泡一致性由桥接保证；note 渲染为附带说明 tool 泡
        setBusy(true);
        const note = m.note;
        setMessages((ms) => {
          const next: UiMsg[] = [...ms, { id: crypto.randomUUID(), role: "user", text: m.display, sentText: m.sent, attachKind: deriveAttachKind(m.sent) }];
          if (note) next.push({ id: crypto.randomUUID(), role: "tool", text: note, sentText: m.sent });
          return next;
        });
        break;
      }
      case "chat.sync": {
        // 工作区快照收尾帧（顺序：folder.bound → history → lists → 本帧）：补齐在途轮/挂起审批/草稿
        snapshotPhaseRef.current = false;
        setBusy(m.busy);
        setCompactSince(m.compacting ? Date.now() : null); // 快照权威：接入时刻近似起算秒数
        setStreaming(m.busy ? m.streamText : null); // 续播在途流式（空串 = 等首帧 delta，气泡已在）
        setPermReq(m.permReq);
        if (!composingRef.current) setDraft(m.draft);
        const u = m.user;
        if (u) {
          // 在途轮的用户气泡未落盘（历史回放没有），靠快照补齐
          setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "user", text: u.display, sentText: u.sent, attachKind: deriveAttachKind(u.sent) }]);
        }
        // 快照无绑定 = 桥接侧尚无工作区绑定：回绑上次文件夹（快照已含绑定时绝不误抢）
        if (!snapshotBoundRef.current) {
          const p = settingsRef.current?.lastFolder;
          if (p) clientRef.current?.send({ type: "folder.bind", path: p, reset: false });
        }
        break;
      }
      case "chat.draft":
        if (!composingRef.current) setDraft(m.text); // 输入法组合中不顶字
        break;
      case "chat.delta":
        setStreaming((s) => (s ?? "") + m.text);
        break;
      case "chat.tool":
        // 工具名与摘要分开传递，由 MessageList 渲染分类图标和非气泡活动行
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "tool", toolName: m.name, text: m.summary }]);
        break;
      case "chat.compact":
        if (m.phase === "start") {
          setCompactSince(Date.now());
        } else {
          setCompactSince(null);
          const meta = m.preTokens !== undefined || m.postTokens !== undefined ? { preTokens: m.preTokens, postTokens: m.postTokens } : null;
          const text = compactRecordText(m.result, m.error, meta);
          // role:"tool" 无 toolName → 复用既有附带状态行渲染（紧凑灰行、非气泡），MessageList 零改动
          setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "tool", text }]);
        }
        break;
      case "settings.state": {
        const current = settingsRef.current;
        if (current) {
          const executionChanged = hasExecutionSettingsChange(current, m);
          const next = mirrorExecutionSettings(current, m);
          settingsRef.current = next;
          setSettings(next); // 只更新内存，迟到镜像不再回写共享存储
          if (executionChanged) setSettingsError("");
        }
        const nextRuntime = runtimeFromSettingsState(runtimeRef.current, m);
        if (nextRuntime !== runtimeRef.current) commitRuntime(nextRuntime);
        break;
      }
      case "settings.error":
        setSettingsError(m.message); //  busy 与聊天消息完全不动
        break;
      case "chat.done":
        setBusy(false);
        setSessionId(m.sessionId);
        prevBoundSidRef.current = m.sessionId;
        // chat.done 可只携带 fast 或 effort：逐字段合并，缺字段保留最近真值，不再以 model 存在为前提
        commitRuntime(mergeDoneRuntime(runtimeRef.current, m));
        setForceAttach(m.compacted === true); // compact 后下一轮强制带页面（上下文里的页面内容已被压缩掉）
        setStreaming((s) => {
          if (s) setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: s }]);
          return null;
        });
        break;
      case "chat.error":
        setBusy(false);
        setCompactSince(null); // 轮次异常终结：压缩提示不悬挂
        setStreaming(null);
        setForceAttach(false); // 本轮异常结束：强制附带随之失效
        setMessages((ms) => [...ms, { id: crypto.randomUUID(), role: "assistant", text: `⚠️ ${m.message}` }]);
        break;
      case "chat.aborted":
        // 手动停止：已生成的部分文字保留为正式气泡，另加停止标记（对齐 CLI 按 ESC 的观感）
        setBusy(false);
        setCompactSince(null); // 中止时压缩中提示一并取消（压缩帧随旧轮作废）
        setForceAttach(false); // 本轮被中止：强制附带随之失效
        setPermReq(null); // 中止时挂起的审批卡片一并取消（桥接已按拒绝释放）
        setStreaming((s) => {
          setMessages((ms) => [
            ...ms,
            ...(s ? [{ id: crypto.randomUUID(), role: "assistant" as const, text: s }] : []),
            { id: crypto.randomUUID(), role: "assistant" as const, text: "⏹ 已手动停止本轮生成" },
          ]);
          return null;
        });
        break;
      case "permission.request":
        setPermReq({ requestId: m.requestId, tool: m.tool, detail: m.detail });
        break;
      case "permission.resolved":
        setPermReq(null); // 任一视图已裁决（含本视图，幂等）
        break;
    }
  }

  /** 建立（或重建）WS 连接 */
  function connect(s: ExtSettings): void {
    settingsRef.current = s; // auth.ok 的启动消息同步读取，避免等待下一次 React 渲染
    clientRef.current?.close();
    const c = new BridgeClient({
      getUrl: () => `ws://${s.host}:${s.port}/ws?token=${encodeURIComponent(s.token)}`,
      onMessage: onServerMessage,
      getHelloMessages: () => {
        const current = settingsRef.current;
        if (!current) return [{ type: "client.ready" }]; // 连接必由已加载设置发起；仅作防御性兜底
        return [
          toSettingsSet(current, true), // 自动 hello 只播种未初始化桥
          { type: "client.ready" },
        ];
      },
      onState: (state) => {
        setConn(state);
        if (state !== "open") {
          setBusy(false); // 断线即丢失在途帧：解除 busy 防界面卡死（重连后快照恢复真实 busy）
          setCompactSince(null); // 压缩提示同属瞬时状态：断线即清，快照恢复
        }
      },
    });
    clientRef.current = c;
    c.connect();
  }

  useEffect(() => {
    void (async () => {
      const s = await loadSettings();
      setSettings(s);
      commitRuntime(await loadRuntimeCache()); // 上次会话的实际生效模型/effort/fast；首轮回报前作为缓存显示
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

  // 弹窗模式初始化：拿自身窗口 ID + 钉住页标题（芯片显示）
  useEffect(() => {
    if (popupTabId === null) return;
    void (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        setPinWinId(win.id ?? null);
      } catch {
        // 拿不到就只缺聚焦能力，不影响聊天
      }
      await refreshPinTab(popupTabId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 弹窗模式：连接就绪且钉住信息齐备后向后台上报 pin（驱动被钉页面的关联徽标；别名/换绑变化时重报）
  useEffect(() => {
    if (popupTabId === null || pinWinId === null || pinTabId === null || conn !== "open") return;
    const name = aliases.find((a) => a.id === currentAliasId)?.name ?? "";
    void chrome.runtime
      .sendMessage({ type: "ccc.pin.report", winId: pinWinId, tabId: pinTabId, aliasName: name, hue: aliasHue(currentAliasId) })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupTabId, pinWinId, pinTabId, conn, currentAliasId, aliases]);

  // 弹窗模式：URL 指定了别名时，等别名列表到达后自动选中一次（不存在则跟随工作区当前别名）
  useEffect(() => {
    if (popupTabId === null || popupAliasId === null || aliasSelectTriedRef.current || conn !== "open") return;
    if (aliases.length === 0) return; // 快照未到，等
    aliasSelectTriedRef.current = true;
    if (currentAliasId !== popupAliasId && aliases.some((a) => a.id === popupAliasId)) {
      clientRef.current?.send({ type: "alias.select", id: popupAliasId, reset: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliases, currentAliasId, conn, popupTabId, popupAliasId]);

  // 弹窗模式：窗口标题跟随别名（多弹窗并排/任务栏区分用）
  useEffect(() => {
    if (popupTabId === null) return;
    const name = aliases.find((a) => a.id === currentAliasId)?.name;
    document.title = name ? `CopilotCC · ${name}` : "CopilotCC 弹窗";
  }, [popupTabId, aliases, currentAliasId]);

  /**
   * 刷新钉住页标题/地址（芯片显示用）。
   * @param tabId 钉住的页面 tab
   */
  async function refreshPinTab(tabId: number): Promise<void> {
    try {
      const t = await chrome.tabs.get(tabId);
      setPinTabTitle(t.title ?? t.url ?? `tab ${tabId}`);
      setPinTabUrl(t.url ?? "");
    } catch {
      setPinTabTitle("页面已关闭");
      setPinTabUrl("");
    }
  }

  /** 弹出独立窗口：当前活动 tab 钉给弹窗；同 tab 去重聚焦由后台负责 */
  async function openPopup(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await chrome.runtime.sendMessage({ type: "ccc.popup.open", tabId: tab.id, aliasId: currentAliasId });
    } catch {
      // 后台不可用：静默（极端情况，正常不会发生）
    }
  }

  /** 🎯 指向当前页：改钉到最后聚焦普通窗口的活动 tab（徽标换页由后台 pin 流程负责） */
  async function repointToCurrent(): Promise<void> {
    try {
      const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
      const tab = win.tabs?.find((t) => t.active);
      if (!tab?.id) return;
      setPinTabId(tab.id);
      await refreshPinTab(tab.id);
    } catch {
      // 无可用普通窗口：忽略
    }
  }

  /** ⇱ 回侧边栏：在钉住页所在窗口打开侧边栏（快照+镜像恢复全部状态），再关弹窗 */
  async function backToSidepanel(): Promise<void> {
    try {
      if (pinTabId !== null) {
        const t = await chrome.tabs.get(pinTabId);
        await chrome.sidePanel.open({ windowId: t.windowId });
      }
    } catch {
      // 页面没了就只关弹窗
    }
    window.close();
  }

  /**
   * 草稿本地变更：立即上屏 + 防抖 200ms 上报桥接（镜像到其它视图）；输入法组合中暂缓上报。
   * @param t 最新草稿
   */
  function handleDraftChange(t: string): void {
    setDraft(t);
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (!composingRef.current) clientRef.current?.send({ type: "chat.draft", text: t });
    }, 200);
  }

  /** 打开当前别名（无别名时当前绑定）所在文件夹；桥接顺手落续聊脚本，folder.opened 反馈在 AliasBar 按钮旁 */
  function handleOpenFolder(): void {
    clientRef.current?.send({ type: "folder.open" });
  }

  async function handleBind(p: string): Promise<void> {
    if (!p.trim()) return;
    await pushFolderHistory(p.trim());
    const stored = await loadSettings();
    const current = settingsRef.current;
    const next = { ...(current ?? stored), lastFolder: stored.lastFolder, folderHistory: stored.folderHistory };
    settingsRef.current = next;
    setSettings(next); // 只回填本地文件夹字段，不用存储快照覆盖服务器执行设置
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

  async function handleSend(text: string, uploads: PendingUpload[] = []): Promise<void> {
    const s = settingsRef.current;
    if (!s || !bound || busy) return; // busy 兜底：一轮未完结不再发（发送键已换成停止键，防 Enter 竞态连发）
    let page: PageSnapshot | null = null;
    let attachFull = false;
    let attachNote: string | null = null;
    // 页面信息丰富度：取当前别名配置（无别名或未设置 = 标准档）；决定附带全文的截断上限
    const richness = aliases.find((a) => a.id === currentAliasId)?.pageRichness ?? "standard";
    const pageCap = PAGE_RICHNESS_CAPS[richness];
    const force = forceAttach; // 本次强制看页面：无视附带开关与同页去重
    if (s.attachEnabled || force) {
      // 弹窗模式钉住原 tab（弹窗聚焦时活动 tab 是弹窗自己）；侧边栏取当前活动 tab
      const snap = popupTabId !== null && pinTabId !== null ? await snapshotTab(pinTabId) : await snapshotActiveTab();
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
          ? `📄 已强制附带页面《${page.title}》正文 ${Math.min(page.markdown.length, pageCap)} 字符${page.markdown.length > pageCap ? `（原文 ${page.markdown.length}，按丰富度截断）` : ""}`
          : attachFull && page.markdown
            ? `📄 已附带页面《${page.title}》正文 ${Math.min(page.markdown.length, pageCap)} 字符${page.markdown.length > pageCap ? `（原文 ${page.markdown.length}，按丰富度截断）` : ""}`
            : page.selection
              ? `📎 已附带选中文字${attachFull && !page.markdown ? `（正文提取失败${snap.error ? `：${snap.error}` : ""}）` : "（页面全文已在会话上下文）"}`
              : "ℹ️ 同页追问：未重复附带全文（此前已进会话上下文）";
    }
    const full = composeMessage(text, page, attachFull, richness);
    const hasUp = uploads.length > 0;
    const c = clientRef.current;
    if (!c) return; // 未连接：不发（界面本来就禁用输入，此处只是兜底）
    // 气泡不做乐观上屏：桥接组装后统一广播 chat.user（display=原始输入，note=附带说明）上屏，各视图天然一致；
    // 上传结果由桥接落盘后广播 chat.tool（真实路径，重名后缀以桥接为准）
    c.send({ type: "chat.send", text: full, display: text, ...(attachNote ? { note: attachNote } : {}), ...(hasUp ? { uploads } : {}) });
    setBusy(true); // 发送即进入"生成中"：停止键立刻出现，不等首字（思考/工具调用期也可中止）
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current); // 草稿本地即清；桥接随后广播 chat.draft "" 兜底全部视图
    setDraft("");
  }

  /** 更新执行设置；以最新服务器内存镜像构造快照，fields 限定本次变更，fast-only 走原生接口。 */
  async function applySettings(patch: ExecutionSettingsPatch): Promise<void> {
    const stored = await saveSettings(patch);
    const current = settingsRef.current ?? stored;
    const next = { ...current, ...patch }; // 存储可能留有失败回滚前的 fast，不得覆盖服务器内存镜像
    settingsRef.current = next;
    setSettings(next);
    setSettingsError("");
    const keys = Object.keys(patch);
    const fastOnly = patch.fastMode !== undefined && keys.every((k) => k === "fastMode");
    const fields = keys as Array<keyof ExecutionSettingsPatch>;
    clientRef.current?.send(fastOnly ? toFastSettingsSet(next) : toSettingsSet(next, false, fields));
  }

  async function handleModeChange(m: PermissionModeSetting): Promise<void> {
    await applySettings({ permissionMode: m });
  }

  /** 重新配对：保存新连接参数、清掉旧桥的界面状态并重连（新桥的 chat.sync 快照会驱动回绑 lastFolder） */
  async function handlePair(info: PairingInfo): Promise<void> {
    const s = await saveSettings({ token: info.t, port: info.p, host: info.h });
    setAuthError("");
    setShowGate(false);
    const current = settingsRef.current;
    const next = { ...(current ?? s), token: s.token, port: s.port, host: s.host };
    settingsRef.current = next;
    setSettings(next); // 配对只改连接字段，保留当前内存中的执行设置直到新桥快照到达
    // 换桥 = 换世界：清掉旧桥留下的界面状态，由新桥的 folder.bound/history/chat.sync 重建
    prevFolderRef.current = null;
    prevBoundSidRef.current = null;
    snapshotPhaseRef.current = false;
    snapshotBoundRef.current = false;
    aliasSelectTriedRef.current = false;
    setBound(null);
    setMessages([]);
    setStreaming(null);
    setSessions([]);
    setAliases([]);
    setCurrentAliasId(null); // 换桥：旧桥别名作废，等新桥 alias.list.data 重建
    setSessionId(null);
    setDraft("");
    runtimeRef.current = {};
    setRuntime({}); // 新桥的实际生效值未知，连缓存一起清，等 settings.state/chat.done 重建
    void clearRuntimeCache();
    connect(next); // connect 会同步设置 settingsRef，必须传入刚合并的内存镜像而非存储快照
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

  const currentAliasName = aliases.find((a) => a.id === currentAliasId)?.name ?? null;

  return (
    <div className="app">
      <div className={`conn ${conn}`}>
        <span>{conn === "open" ? "● 已连接" : conn === "connecting" ? "● 连接中…" : "● 已断开（自动重连中）"}</span>
        {conn === "open" && compactSince !== null ? (
          <span className="compact-hint">正在压缩…（{Math.floor((Date.now() - compactSince) / 1000)}s）</span>
        ) : null}
        <span>
          {popupTabId === null ? (
            <button className="pair-btn" title="在独立窗口打开此会话（镜像模式：两边同步；再点扩展图标可隐藏侧边栏，弹窗不受影响）" onClick={() => void openPopup()}>🗖 弹出</button>
          ) : null}
          <button className="pair-btn" title="重新配对（改端口 / 换桥接）" onClick={() => setShowGate(true)}>⚙ 配对</button>
        </span>
      </div>
      {popupTabId !== null ? (
        <div className="popup-bar">
          <span className="pin-chip" title={pinTabUrl || undefined}>
            📌 {currentAliasName ?? "未选别名"} · {pinTabTitle || "…"}
          </span>
          <button className="mini-btn" title="改钉到最后聚焦窗口的当前页（页面徽标随之换页）" onClick={() => void repointToCurrent()}>🎯 指向当前页</button>
          <button className="mini-btn" title="在钉住页窗口打开侧边栏并关闭本弹窗（会话完全恢复）" onClick={() => void backToSidepanel()}>⇱ 回侧边栏</button>
        </div>
      ) : null}
      <AliasBar
        aliases={aliases}
        currentAliasId={currentAliasId}
        history={settings.folderHistory}
        bound={bound}
        resumed={resumed}
        sessionId={sessionId}
        sessions={sessions}
        onAliasSelect={(id) => clientRef.current?.send({ type: "alias.select", id })}
        onAliasCreate={(name, folder, sid, richness) => clientRef.current?.send({ type: "alias.create", name, folder, sessionId: sid, pageRichness: richness })}
        onAliasUpdate={(id, patch) => clientRef.current?.send({ type: "alias.update", id, ...patch })}
        onAliasDelete={(id) => clientRef.current?.send({ type: "alias.delete", id })}
        onPickFolder={handlePickFolder}
        onBind={handleBind}
        onNewSession={() => clientRef.current?.send({ type: "session.new" })}
        onSwitchSession={(id) => clientRef.current?.send({ type: "session.switch", sessionId: id })}
        onDeleteSession={(id) => clientRef.current?.send({ type: "session.delete", sessionId: id })}
        onOpenFolder={handleOpenFolder}
        openFolderFlash={openFolderFlash}
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
        busy={busy}
        attachEnabled={settings.attachEnabled}
        permissionMode={settings.permissionMode}
        model={settings.model}
        effort={settings.effort}
        effectiveModel={runtime.model ? shortModelName(runtime.model) : undefined}
        effectiveEffort={runtime.effort}
        fastMode={settings.fastMode}
        fastRuntime={runtime.fast}
        settingsError={settingsError}
        forceAttach={forceAttach}
        onToggleForceAttach={() => setForceAttach((v) => !v)}
        onToggleAttach={async (v) => { const saved = await saveSettings({ attachEnabled: v }); const current = settingsRef.current; const next = { ...(current ?? saved), attachEnabled: saved.attachEnabled }; settingsRef.current = next; setSettings(next); }}
        onModeChange={handleModeChange}
        onModelChange={(v) => void applySettings({ model: v })}
        onEffortChange={(v) => void applySettings({ effort: v })}
        onFastModeChange={(v) => void applySettings({ fastMode: v })}
        draft={draft}
        onDraftChange={handleDraftChange}
        onComposition={(v) => { composingRef.current = v; }}
        onSend={handleSend}
        onStop={() => clientRef.current?.send({ type: "chat.abort" })}
      />
    </div>
  );
}
