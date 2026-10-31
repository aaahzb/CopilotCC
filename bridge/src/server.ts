/** ccc-bridge 服务端：WS 桥（握手鉴权 + 镜像工作区广播）+ 内置 /config 端口设置页（在线改端口）。 */
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { encode, parseClientMessage, sanitizeElicitationUrl, validateElicitationContent, type PermissionModeSetting, type EffortLevelSetting, type ServerMessage, type ExecutionRuntime } from "./protocol";
import type { ClientMessage, AskRequest, InteractionRequest, InteractionRecord, InteractionOutcome, TimelineItem } from "./protocol";
import { isValidFolder, normalizeFolder, SessionManager } from "./session-manager";
import { createClaudeSession, type ClaudeSessionLike } from "./claude-session";
import type { SessionRuntimeInfo } from "./claude-session";
import { readTranscriptPage, listSessions, deleteTranscript, compactBoundaryText } from "./transcript";
import { saveConfig, type BridgeConfig } from "./config";
import { encodePairing } from "./pairing";
import { AliasManager } from "./alias-manager";
import { pickFolder as defaultPickFolder, openInFileManager as defaultOpenFolder } from "./folder-picker";
import { saveUploads } from "./uploads";
import { composeUploadNote, UPLOAD_DIR } from "./upload-note";
import { writeResumeScript, removeResumeScript } from "./resume-script";
import { WorkspaceStore, type FastRestoreBaseline, type WorkspaceExecutionSettings } from "./workspace-store";
import { InteractionStore } from "./interaction-store";

/** 服务依赖。createSession 仅供测试注入假会话工厂。 */
export interface ServerDeps {
  config: BridgeConfig;
  sessions: SessionManager;
  createSession?: typeof createClaudeSession;
  /** 配置目录：在线改端口后把新端口写回 config.json；缺省时 /config 只允许查看、保存返回 503（测试模式） */
  configDir?: string;
  /** 在线改端口成功后回调（托盘更新菜单文案、写 runtime.json） */
  onPortChanged?: (port: number) => void;
  /** 别名存储；缺省时 alias.* 回空列表（测试不注入即关闭该功能） */
  aliases?: AliasManager;
  /** 系统文件夹选择框实现；测试注入假实现，缺省用平台原生对话框 */
  pickFolder?: () => Promise<string | null>;
  /** 系统文件管理器打开实现（folder.open）；测试注入假实现，缺省用平台原生（explorer/open/xdg-open） */
  openFolder?: (path: string) => Promise<boolean>;
  /** 工作区绑定持久化（桥接重启后恢复 文件夹+别名）；缺省时关闭恢复（测试不注入即不恢复） */
  workspaceStore?: WorkspaceStore;
}

/** 启动结果：wss/port 始终指向当前实例（在线改端口后跟随），close 关闭当前实例并终结会话，setPort 在线改端口 */
export interface StartedServer {
  /** 当前 WS 服务实例 */
  readonly wss: WebSocketServer;
  /** 当前实际监听的端口（config.port=0 时为系统分配） */
  readonly port: number;
  /**
   * 在线切端口：先在新端口完成监听+自探测，成功后才拆旧服务（含写回 config.json、触发 onPortChanged）。
   * 工作区（含进行中的会话）原地不动，只换监听。
   * @param target 目标端口（被无关程序占用时顺延，最多 10 个）
   * @returns 实际生效的端口
   * @throws 候选端口耗尽，或目标被同配置的另一个桥接实例占用
   */
  setPort: (target: number) => Promise<number>;
  close: () => Promise<void>;
}

/** 一套运行中的监听：HTTP 服务（/config 页 + WS 升级）+ WS 服务 + 实际端口 */
interface Running {
  http: http.Server;
  wss: WebSocketServer;
  port: number;
}

/** 端口自探测结论：ok=确实是本进程；duplicate=另一个 ccc-bridge；foreign=无关程序/超时 */
type ProbeVerdict = "ok" | "duplicate" | "foreign";

/**
 * 镜像工作区：桥接进程内唯一的会话工作区。侧边栏/弹窗等全部视图共享这一份状态；
 * 视图（WS 连接）可以随便断开重连，工作区与进行中的会话都原地不动（桥接进程退出才终结）。
 */
/** 一次 fast 控制涉及的完整请求快照；模型仍是请求值，不是 CC 真值。 */
interface FastExecutionSnapshot {
  fastMode: boolean;
  model: string | undefined;
  fastRestore?: FastRestoreBaseline;
}

/** 克隆恢复基线，避免请求、工作区与回滚快照共享可变对象。 */
function cloneFastRestore(restore: FastRestoreBaseline | undefined): FastRestoreBaseline | undefined {
  return restore ? { ...restore } : undefined;
}

/** 克隆完整 fast 请求快照。 */
function cloneFastSnapshot(snapshot: FastExecutionSnapshot): FastExecutionSnapshot {
  return {
    fastMode: snapshot.fastMode,
    model: snapshot.model,
    ...(snapshot.fastRestore ? { fastRestore: cloneFastRestore(snapshot.fastRestore) } : {}),
  };
}

/** 比较 fast、请求模型与恢复证据是否全部一致。 */
function sameFastSnapshot(a: FastExecutionSnapshot, b: FastExecutionSnapshot): boolean {
  return a.fastMode === b.fastMode
    && a.model === b.model
    && a.fastRestore?.request === b.fastRestore?.request
    && a.fastRestore?.actualModel === b.fastRestore?.actualModel;
}

interface Workspace {
  /** 当前绑定的文件夹 */
  folder: string | null;
  /** 当前 Claude 会话（绑定文件夹即创建；换绑/换会话时重建） */
  claude: ClaudeSessionLike | null;
  /** Query 代次；旧 Query 的迟到事件一律忽略 */
  sessionEpoch: number;
  mode: PermissionModeSetting;
  model: string | undefined;
  effort: EffortLevelSetting | undefined;
  /** 用户请求的 CC 原生 fast 设置；旧客户端省略时保留 */
  fastMode: boolean;
  /** fast on 前的请求模型与可选 CC 实际模型证据，仅桥接和磁盘使用 */
  fastRestore?: FastRestoreBaseline;
  /** 最近一次原生接受或新 Query 携带的完整快照；只用于失败回滚，不是实际状态 */
  fastRollback: FastExecutionSnapshot;
  /** fast-only 请求序号；同值 ABA 场景也不能让旧结果回滚新请求 */
  fastRequestSeq: number;
  /** 已计入回滚基线的请求序号，防止较旧的成功结果倒写基线 */
  fastRollbackSeq: number;
  /** 已初始化后自动 hello 不再覆盖工作区 */
  settingsInitialized: boolean;
  /** fast-only 请求后等待 CC 新 fast 真值 */
  fastPending: boolean;
  /** CC init/result 最近确认的执行真值；与请求设置分开保存 */
  runtime: ExecutionRuntime;
  /** true 时 runtime 是权威快照，即使为空也应清客户端旧值；重启尚未恢复时保持 false */
  runtimeAuthoritative: boolean;
  /** 当前进行中的别名（alias.select/create 设置，粘性跟随文件夹/会话变化） */
  currentAliasId: string | null;
  /** 本轮回答进行中（chat.send 受理 → done/error/aborted） */
  busy: boolean;
  /** 工作区正在压缩上下文（chat.sync 快照供中途接入的视图立即提示） */
  compacting: boolean;
  /** CC 正在等待 API 响应；仅瞬时镜像，不写入永久时间线 */
  requesting: boolean;
  /** 本轮已流出的部分文本（快照给中途接入的视图补流式；轮次结束清空） */
  streamText: string;
  /** 在途轮的用户气泡（chat.user 已广播但尚未落盘，历史回放里没有，快照靠它补齐） */
  inflightUser: { display: string; sent: string } | null;
  /** 挂起的权限审批（permission.request 已广播未裁决；快照给中途接入的视图补卡片） */
  pendingPerm: { requestId: string; tool: string; detail: string } | null;
  /** 挂起的提问（chat.ask 已广播未作答；快照补卡片，任一视图作答后全视图撤下） */
  pendingAsk: AskRequest | null;
  /** 全部并发挂起交互；requestId 唯一，不能再由同类单槽互相覆盖 */
  pendingInteractions: Map<string, InteractionRequest>;
  /** 已解决但可能尚未写入 CLI 转录的只读结果，供新视图补齐 */
  interactions: InteractionRecord[];
  /** 本轮工具调用索引；结果帧据此补齐名称、摘要并更新同一 toolUseId */
  toolCalls: Map<string, { name: string; summary: string; input?: string }>;
  /** 本轮按真实顺序排列的在途消息；新视图据稳定 ID 恢复，不再拼接单段 streamText */
  timeline: TimelineItem[];
  /** 尚未拿到会话 ID 的侧车记录；onSessionId/onDone 落地后冲刷 */
  sidecarPending: TimelineItem[];
  /** 输入框草稿镜像（chat.draft 上报更新；弹窗与侧边栏接力输入） */
  draft: string;
}

/** attachHandlers 需要的工作区上下文（startServer 内组装；在线切端口换 wss 时复用同一工作区） */
interface HandlerCtx {
  workspace: Workspace;
  /** 全部已认证连接（跨在线切端口共享；旧 wss 的连接被 terminate 后从集合摘除） */
  clients: Set<WebSocket>;
  /** 广播状态事件给全部视图；except 用于 chat.draft 回显抑制（上报方已有本地草稿，回包会顶跳光标） */
  broadcast: (m: ServerMessage, except?: WebSocket) => void;
  /** 唯一人工裁决收口；消息处理器与会话事件共用同一挂起 Map */
  settleInteraction: (
    requestId: string,
    outcome: InteractionOutcome,
    result?: Pick<InteractionRecord, "answers" | "feedback" | "decider" | "elicitationAction" | "submittedFields" | "userDialogAction">,
  ) => InteractionRecord | null;
  /** 组装当前执行设置；includeRuntime=true 时携带/清空 CC 运行时真值 */
  settingsStateMsg: (includeRuntime?: boolean) => ServerMessage;
  /** 绑定文件夹并重建会话（folder.bind 与 alias.select/create 共用） */
  bindFolder: (p: string, forceSessionId?: string | null, reset?: boolean) => void;
  /** 为当前文件夹创建（或重建）Claude 会话 */
  openSession: (resumeId?: string) => void;
  /** 清空在途轮次；clearConversation=true 同时清除旧会话的近期交互记录 */
  resetInflight: (
    outcome?: "cancelled" | "error",
    decider?: "abort" | "close" | "system",
    clearConversation?: boolean,
  ) => void;
  /** client.ready 快照推送（只发请求方） */
  pushSnapshot: (send: (m: ServerMessage) => void) => void;
  /** 转录与侧车合并后的历史分页 */
  readHistoryPage: (
    folder: string,
    sessionId: string,
    options?: { limit?: number; before?: string },
  ) => ReturnType<typeof readTranscriptPage>;
  /** folder.open 处理（只回请求方） */
  handleFolderOpen: (send: (m: ServerMessage) => void) => Promise<void>;
  /** 删除会话时同步删除其桥接侧车 */
  deleteHistorySidecar: (folder: string, sessionId: string) => void;
  /** 广播会话列表 */
  pushSessionList: () => void;
  /** 广播别名列表 */
  pushAliasList: () => void;
  /** 组装会话列表消息（未绑定文件夹时为 null） */
  sessionListMsg: () => ServerMessage | null;
  /** 组装别名列表消息（未注入别名存储时为 null） */
  aliasListMsg: () => ServerMessage | null;
  /** 当前别名粘性同步（别名跟着工作区走，永不脱钩） */
  syncCurrentAlias: () => void;
  /** 当前别名的续聊脚本保鲜 */
  refreshAliasScript: () => void;
  /** 持久化工作区绑定（文件夹+当前别名），供桥接重启后恢复 */
  persistWorkspace: () => void;
  /** 读取当前完整 fast 请求快照 */
  currentFastSnapshot: () => FastExecutionSnapshot;
  /** 一次性提交完整 fast 请求快照 */
  applyFastSnapshot: (snapshot: FastExecutionSnapshot) => void;
  /** 只持久化执行设置，不写 hello 前尚未恢复的绑定 */
  persistExecutionSettings: () => void;
  /** 工作区未绑定且有持久化记录时恢复绑定（首个视图接入触发；已绑定则空转） */
  restoreWorkspaceIfIdle: () => void;
}

/**
 * 常量时间比较 token，防时序侧信道。
 * @param a 客户端提供
 * @param b 配置中的真值
 * @returns 是否相等
 */
function tokenOk(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * 起 HTTP 服务并监听指定端口（WS 服务挂在同一 HTTP 服务上处理 Upgrade），listening 才返回。
 * @param port 目标端口
 * @param handler 普通 HTTP 请求处理器（/config 设置页）
 * @returns http 服务、WS 服务与实际端口
 * @throws 监听失败（如 EADDRINUSE）时清理后拒绝
 */
function listenOn(port: number, handler: http.RequestListener): Promise<Running> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer(handler);
    const wss = new WebSocketServer({ server: httpServer });
    // ws 会把 http server 的 error 转发到 wss：必须挂监听，否则监听失败会以未捕获异常崩出来。
    // 启动期的错误由 httpServer 的 once("error") 统一走 reject，这里只兜运行期
    let listening = false;
    wss.on("error", (e: Error) => {
      if (listening) console.error("[ccc-bridge] WS 服务运行期错误:", e.message);
    });
    const onError = (e: Error): void => {
      void wss.close();
      httpServer.close();
      reject(e);
    };
    httpServer.once("error", onError);
    httpServer.listen(port, "127.0.0.1", () => {
      listening = true;
      httpServer.removeListener("error", onError);
      resolve({ http: httpServer, wss, port: (httpServer.address() as AddressInfo).port });
    });
  });
}

/**
 * 关停一套 http+ws 服务：先强断所有 WS 客户端（wss.close 会等它们结束），再关 HTTP 监听。
 * @param r 运行中的服务
 */
async function closeRunning(r: Running): Promise<void> {
  for (const c of r.wss.clients) c.terminate();
  await new Promise<void>((res) => r.wss.close(() => res()));
  // 浏览器 fetch 的 keep-alive 空闲连接不拖累关闭；bun 等运行时可能没有该 API，做防御
  (r.http as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  await new Promise<void>((res) => r.http.close(() => res()));
}

/**
 * 自探测：以客户端身份握手刚监听的端口，确认连接真的落到本进程。
 * Windows 下 Node 的 SO_REUSEADDR 允许两个进程同绑一个端口（EADDRINUSE 不可靠），
 * 必须做协议层验证。URL 里带 probe=本进程实例 ID，服务端认出是自己后跳过 Origin 校验。
 * @param port 目标端口
 * @param token 配对 token
 * @param instanceId 本进程实例 ID
 * @returns 探测结论
 */
function selfVerify(port: number, token: string, instanceId: string): Promise<ProbeVerdict> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&probe=${instanceId}`);
    const timer = setTimeout(() => finish("foreign"), 1500);
    let settled = false;
    function finish(v: ProbeVerdict): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate(); // CONNECTING 状态下 close() 不断开底层 socket，必须 terminate 才不泄漏探测连接
      } catch {
        // 已关闭
      }
      resolve(v);
    }
    ws.once("message", (d) => {
      let v: ProbeVerdict = "foreign";
      try {
        const m = JSON.parse(d.toString()) as { type?: string; instance?: string };
        // auth.fail（token/origin 不符）按 foreign 处理；auth.ok 但实例不同说明是同配置的另一个桥
        if (m.type === "auth.ok") v = m.instance === instanceId ? "ok" : "duplicate";
      } catch {
        // 非 JSON 响应 → foreign
      }
      finish(v);
    });
    ws.once("error", () => finish("foreign"));
    ws.once("close", () => finish("foreign"));
  });
}

/** 重复实例错误消息（两处探测路径共用同一文案） */
function duplicateError(port: number): Error {
  return new Error(`端口 ${port} 已被另一个 ccc-bridge 实例占用（配置相同）。请先退出旧实例：托盘右键→退出，或结束对应进程。`);
}

/**
 * 生成 /config 设置页 HTML。当前端口内联进页面；token 不写进 HTML（页面 JS 从 URL query 读取）。
 * @param port 当前端口
 * @returns 完整 HTML 文档
 */
function configPage(port: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CopilotCC 桥接 · 修改端口</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:460px;margin:2.5em auto;padding:0 1em;color:#222}
 h1{font-size:1.25rem}
 .row{display:flex;gap:.5em;align-items:center;margin:1em 0}
 input{font-size:1rem;padding:.35em .5em;width:8em}
 button{font-size:.95rem;padding:.4em 1em;cursor:pointer}
 #msg{min-height:1.4em;color:#c00}
 #pair{background:#f4f4f4;border:1px solid #ddd;border-radius:6px;padding:.6em;font-family:monospace;font-size:.8rem;word-break:break-all;user-select:all}
 #done{display:none}
 .muted{color:#666;font-size:.85rem}
</style>
</head>
<body>
<h1>CopilotCC 桥接 · 修改端口</h1>
<p class="muted">当前端口：<b id="cur">${port}</b>。保存后桥接立即切换到新端口（当前会话连接会断开），需重新配对一次：复制新配对串 → 扩展侧栏「⚙ 配对」粘贴。</p>
<div class="row">
  <label for="p">新端口</label>
  <input id="p" type="number" min="1024" max="65535" placeholder="1024-65535">
  <button id="save">保存并切换</button>
</div>
<p id="msg"></p>
<div id="done">
  <p>✅ 已切换到端口 <b id="newp"></b>。新配对串：</p>
  <div id="pair"></div>
  <div class="row"><button id="copy">复制配对串</button></div>
  <p class="muted">到扩展侧栏点「⚙ 配对」粘贴即可；托盘「复制配对串」也已是新端口。本页面可以关闭了。</p>
</div>
<script>
var token = new URLSearchParams(location.search).get("t") || "";
var msg = document.getElementById("msg");
document.getElementById("save").onclick = async function () {
  msg.style.color = "#c00"; msg.textContent = "";
  var port = Number(document.getElementById("p").value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { msg.textContent = "端口需为 1024-65535 的整数"; return; }
  try {
    var r = await fetch("/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token, p: port }) });
    var d = await r.json();
    if (!r.ok || !d.ok) { msg.textContent = d.error || ("失败：" + r.status); return; }
    document.getElementById("newp").textContent = d.port;
    document.getElementById("pair").textContent = d.pairing;
    document.getElementById("done").style.display = "block";
    document.getElementById("cur").textContent = d.port;
  } catch (e) { msg.textContent = "请求失败：" + e; }
};
document.getElementById("copy").onclick = async function () {
  try { await navigator.clipboard.writeText(document.getElementById("pair").textContent); msg.style.color = "#080"; msg.textContent = "已复制"; }
  catch (e) { msg.style.color = "#c00"; msg.textContent = "复制失败，请手动全选配对串复制"; }
};
</script>
</body>
</html>`;
}

/**
 * 读 POST JSON 体（限 4KB，超限/非法 JSON 返回 null）。
 * @param req 请求
 * @returns 解析出的对象，失败为 null
 */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4096) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null)); // 客户端中途断开：兜底结算（正常路径 end 已先结算）
  });
}

/** /config 请求上下文：配置、持久化目录（缺省=禁止保存）、当前端口访问器与在线切换函数 */
interface ConfigHttpCtx {
  config: BridgeConfig;
  configDir?: string;
  getPort: () => number;
  rebind: (target: number) => Promise<number>;
}

/**
 * 普通 HTTP 请求处理：只服务 /config（GET 表单页 / POST 改端口），其余 404。
 * Host 头校验与 WS 一致（防 DNS rebinding）；全部响应带 Connection: close，
 * 不留 keep-alive 空闲连接，在线切端口时旧服务能立刻拆干净。
 * @param req 请求
 * @param res 响应
 * @param ctx 上下文
 */
async function handleConfigRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ConfigHttpCtx): Promise<void> {
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
    res.writeHead(403, { Connection: "close" }).end("Forbidden");
    return;
  }
  const url = new URL(req.url ?? "", "http://127.0.0.1");
  if (url.pathname !== "/config") {
    res.writeHead(404, { Connection: "close" }).end("Not Found");
    return;
  }
  if (req.method === "GET") {
    if (!tokenOk(url.searchParams.get("t") ?? "", ctx.config.token)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end("token 无效：请从托盘菜单「修改端口」进入");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" }).end(configPage(ctx.getPort()));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Connection: "close" }).end();
    return;
  }
  const send = (status: number, obj: Record<string, unknown>): void => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", Connection: "close" }).end(JSON.stringify(obj));
  };
  if (!ctx.configDir) {
    send(503, { ok: false, error: "当前运行模式不支持在线改端口" });
    return;
  }
  const body = await readJsonBody(req);
  if (!body || typeof body.t !== "string" || !tokenOk(body.t, ctx.config.token)) {
    send(403, { ok: false, error: "token 无效" });
    return;
  }
  const p = body.p;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1024 || p > 65535) {
    send(400, { ok: false, error: "端口需为 1024-65535 的整数" });
    return;
  }
  if (p === ctx.getPort()) {
    // 目标就是当前端口：无需切换，直接回新配对串（幂等，便于用户重复点保存）
    send(200, { ok: true, port: p, pairing: encodePairing({ h: "127.0.0.1", p, t: ctx.config.token }) });
    return;
  }
  try {
    const port = await ctx.rebind(p); // 内含写回 config.json 与 onPortChanged 回调
    send(200, { ok: true, port, pairing: encodePairing({ h: "127.0.0.1", p: port, t: ctx.config.token }) });
  } catch (e) {
    send(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 启动 WS 桥接服务（异步完成监听）。只绑 127.0.0.1；Host 头校验防 DNS rebinding；
 * token 认证；配置白名单后强制 Origin 校验。
 * 端口策略：config.port=0 时系统分配（测试/自检）；否则从配置端口起最多顺延 10 个，
 * 每个候选监听成功后做自探测——顺延只对"无关程序占用"生效；发现同 token 的重复实例直接抛错。
 * 同端口上还内置 /config 设置页（token 鉴权）：托盘「修改端口」打开它在线改端口，
 * 改完写回 config.json 并把新配对串展示给用户去扩展侧重新配对。
 * 镜像工作区：进程内唯一工作区（见 Workspace），侧边栏/弹窗等全部已认证连接都是它的视图，
 * 状态事件一律广播；在线切端口只换监听，工作区（含进行中的会话）原地不动。
 * @param deps 配置、会话映射、（测试用）会话工厂、配置目录与端口变更回调
 * @returns wss 实例、实际端口与关闭函数（均跟随在线切换后的当前实例）
 * @throws 候选端口耗尽，或发现重复实例
 */
export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const instanceId = randomBytes(8).toString("hex"); // 本进程实例 ID：自探测认亲用
  const { config, sessions, aliases } = deps;
  const newSession = deps.createSession ?? createClaudeSession;
  const persistedExecution = deps.workspaceStore?.loadExecutionSettings() ?? null;
  const openFolderImpl = deps.openFolder ?? defaultOpenFolder;
  const interactionStore = deps.configDir ? new InteractionStore(path.join(deps.configDir, "interactions")) : undefined;
  let current: Running; // 当前监听着的服务（在线改端口会整体替换）

  /** 唯一工作区：全部视图共享的会话与在途状态 */
  const workspace: Workspace = {
    folder: null,
    claude: null,
    sessionEpoch: 0,
    mode: persistedExecution?.permissionMode ?? "auto",
    model: persistedExecution?.model,
    effort: persistedExecution?.effort,
    fastMode: persistedExecution?.fastMode ?? false,
    fastRestore: cloneFastRestore(persistedExecution?.fastRestore),
    fastRollback: {
      fastMode: persistedExecution?.fastMode ?? false,
      model: persistedExecution?.model,
      fastRestore: cloneFastRestore(persistedExecution?.fastRestore),
    },
    fastRequestSeq: 0,
    fastRollbackSeq: 0,
    settingsInitialized: persistedExecution !== null,
    fastPending: false,
    runtime: {},
    runtimeAuthoritative: false,
    currentAliasId: null,
    busy: false,
    compacting: false,
    requesting: false,
    streamText: "",
    inflightUser: null,
    pendingPerm: null,
    pendingAsk: null,
    pendingInteractions: new Map(),
    interactions: [],
    toolCalls: new Map(),
    timeline: [],
    sidecarPending: [],
    draft: "",
  };
  /** 读取当前完整 fast 请求快照。 */
  function currentFastSnapshot(): FastExecutionSnapshot {
    return {
      fastMode: workspace.fastMode,
      model: workspace.model,
      fastRestore: cloneFastRestore(workspace.fastRestore),
    };
  }

  /** 一次性提交完整 fast 请求快照，禁止模型与恢复基线分别漂移。 */
  function applyFastSnapshot(snapshot: FastExecutionSnapshot): void {
    workspace.fastMode = snapshot.fastMode;
    workspace.model = snapshot.model;
    workspace.fastRestore = cloneFastRestore(snapshot.fastRestore);
  }

  const clients = new Set<WebSocket>();

  function broadcast(m: ServerMessage, except?: WebSocket): void {
    const frame = encode(m);
    for (const c of clients) {
      if (c !== except && c.readyState === WebSocket.OPEN) c.send(frame);
    }
  }

  /** 写入单条侧车事实；磁盘故障不阻断正在进行的聊天。 */
  function writeTimelineItem(folder: string, sessionId: string, item: TimelineItem): void {
    if (!interactionStore) return;
    try {
      interactionStore.append(folder, sessionId, item);
    } catch (e) {
      console.error("[ccc-bridge] 会话时间线保存失败:", e instanceof Error ? e.message : String(e));
    }
  }

  /** 会话 ID 到位后，按首次出现顺序冲刷此前暂存的状态与裁决。 */
  function flushSidecar(folder: string, sessionId: string): void {
    const pending = workspace.sidecarPending.splice(0);
    for (const item of pending) writeTimelineItem(folder, sessionId, item);
  }

  /** 持久化只读事实；尚无会话 ID 时只暂存，避免误写到上一轮会话。 */
  function persistTimelineItem(item: TimelineItem): void {
    const folder = workspace.folder;
    if (!folder || !interactionStore) return;
    const sessionId = sessions.get(folder)?.sessionId;
    if (!sessionId) {
      const old = workspace.sidecarPending.findIndex((pending) => pending.id === item.id);
      if (old >= 0) workspace.sidecarPending[old] = item;
      else workspace.sidecarPending.push(item);
      return;
    }
    flushSidecar(folder, sessionId);
    writeTimelineItem(folder, sessionId, item);
  }

  /** CLI 转录与桥接侧车先合并，再按同一稳定游标分页。 */
  function readHistoryPage(
    folder: string,
    sessionId: string,
    options: { limit?: number; before?: string } = {},
  ): ReturnType<typeof readTranscriptPage> {
    return readTranscriptPage(folder, sessionId, {
      ...options,
      additional: interactionStore?.read(folder, sessionId) ?? [],
    });
  }

  /** 删除会话时同步清理仅供该会话使用的侧车。 */
  function deleteHistorySidecar(folder: string, sessionId: string): void {
    interactionStore?.delete(folder, sessionId);
  }

  /** 唯一人工裁决收口：只处理仍挂起的 requestId，重复/迟到响应不会撤掉新卡或重复记账。 */
  function settleInteraction(
    requestId: string,
    outcome: InteractionOutcome,
    result: Pick<InteractionRecord, "answers" | "feedback" | "decider" | "elicitationAction" | "submittedFields" | "userDialogAction"> = {},
  ): InteractionRecord | null {
    const request = workspace.pendingInteractions.get(requestId);
    if (!request) return null;
    workspace.pendingInteractions.delete(requestId);
    if (workspace.pendingAsk?.requestId === requestId) workspace.pendingAsk = null;
    if (workspace.pendingPerm?.requestId === requestId) workspace.pendingPerm = null;
    // 挂起请求保留完整 URL 供用户打开；只读记录和侧车只保留去敏地址。
    const recordRequest = request.kind === "elicitation" && request.elicitation
      ? {
          ...request,
          elicitation: {
            ...request.elicitation,
            // default 也是潜在表单值；结算后只留字段结构和 submittedFields 名称。
            fields: request.elicitation.fields?.map((field) => ({
              name: field.name, title: field.title, type: field.type, required: field.required,
              ...(field.description !== undefined ? { description: field.description } : {}),
              ...(field.enum !== undefined ? { enum: field.enum } : {}),
            })),
            url: request.elicitation.url ? sanitizeElicitationUrl(request.elicitation.url) ?? undefined : undefined,
          },
        }
      : request;
    const record: InteractionRecord = { ...recordRequest, ...result, outcome, resolvedAt: Date.now() };
    workspace.interactions.push(record);
    const item: TimelineItem = {
      id: `interaction-${requestId}`, createdAt: record.resolvedAt, role: "tool", text: "",
      interaction: record, ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
    };
    workspace.timeline.push(item);
    persistTimelineItem(item);
    if (request.kind === "ask") broadcast({ type: "chat.ask.resolved", requestId, record });
    else if (request.kind === "elicitation" || request.kind === "user_dialog") {
      broadcast({ type: "chat.interaction.resolved", requestId, record });
    } else broadcast({ type: "permission.resolved", requestId, record });
    return record;
  }

  /** 结算当前全部挂起交互；迭代快照避免广播回调修改 Map 时漏项。 */
  function settleAllInteractions(
    outcome: "cancelled" | "error",
    decider: "abort" | "close" | "system",
  ): void {
    for (const requestId of [...workspace.pendingInteractions.keys()]) {
      settleInteraction(requestId, outcome, { decider });
    }
  }

  /** 追加一条只读状态并实时广播；同一 item 随后由快照按稳定 ID 去重恢复。 */
  function pushTimelineStatus(
    text: string,
    options: { id?: string; detail?: string; role?: "tool" | "assistant" } = {},
  ): TimelineItem {
    const id = options.id ?? `status-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const old = workspace.timeline.find((item) => item.id === id);
    const item: TimelineItem = old ?? {
      id, createdAt: Date.now(), role: options.role ?? "tool", text,
    };
    Object.assign(item, {
      text,
      ...(options.role ? { role: options.role } : {}),
      ...(options.detail !== undefined ? { detail: options.detail } : {}),
    });
    if (!old) workspace.timeline.push(item);
    persistTimelineItem(item);
    broadcast({ type: "chat.timeline", item });
    return item;
  }

  /** 运行时真值只由 CC 回报更新；每次整体替换，缺字段不伪造 */
  function setRuntime(info: SessionRuntimeInfo): void {
    const previousMode = workspace.runtime.permissionMode;
    const fastFresh = info.fast !== undefined && info.fastFresh === true;
    if (fastFresh) workspace.fastPending = false; // 只有本帧显式携带合法 fast_mode_state 才能确认等待
    workspace.runtimeAuthoritative = true;
    workspace.runtime = {
      ...(typeof info.model === "string" && info.model.length > 0 ? { model: info.model } : {}),
      ...(info.effort !== undefined ? { effort: info.effort } : {}),
      ...(info.fast && (!workspace.fastPending || fastFresh) ? { fast: info.fast } : {}), // pending 期间不回收缓存 fast
      ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
    };
    if (info.permissionMode && info.permissionMode !== previousMode) {
      const labels: Record<NonNullable<ExecutionRuntime["permissionMode"]>, string> = {
        default: "标准确认", acceptEdits: "自动编辑", bypassPermissions: "跳过权限检查",
        plan: "计划模式", dontAsk: "不再询问", auto: "自动判断",
      };
      pushTimelineStatus(`当前模式：${labels[info.permissionMode]}`);
    }
  }


  /** 请求设置始终全量携带；runtime 仅在需要替换/清空客户端真值时下发 */
  function settingsStateMsg(includeRuntime = false): ServerMessage {
    return {
      type: "settings.state",
      permissionMode: workspace.mode,
      model: workspace.model,
      effort: workspace.effort,
      fastMode: workspace.fastMode,
      ...(workspace.fastPending ? { fastPending: true } : {}),
      ...(includeRuntime ? { runtime: workspace.runtime } : {}),
    };
  }

  function sessionListMsg(): ServerMessage | null {
    if (!workspace.folder) return null;
    return {
      type: "session.list.data",
      sessions: listSessions(workspace.folder),
      currentId: sessions.get(workspace.folder)?.sessionId ?? null,
    };
  }

  function aliasListMsg(): ServerMessage | null {
    if (!aliases) return null;
    const currentId = workspace.currentAliasId && aliases.get(workspace.currentAliasId) ? workspace.currentAliasId : null;
    return { type: "alias.list.data", aliases: aliases.all(), currentId };
  }

  function pushSessionList(): void {
    const m = sessionListMsg();
    if (m) broadcast(m);
  }

  function pushAliasList(): void {
    const m = aliasListMsg();
    if (m) broadcast(m);
  }

  /**
   * 当前别名粘性同步：文件夹/会话变化后把别名数据写回现状（别名跟着工作区走，永不脱钩）。
   * 仅在显式选中/创建过别名后生效；未选中时不做反向匹配，避免手动绑定意外吸附到同状态的旧别名。
   */
  function syncCurrentAlias(): void {
    if (!aliases || !workspace.currentAliasId) return;
    const rec = aliases.get(workspace.currentAliasId);
    if (!rec) {
      workspace.currentAliasId = null;
      return;
    }
    if (!workspace.folder) return;
    const sid = sessions.get(workspace.folder)?.sessionId ?? null;
    if (normalizeFolder(rec.folder) !== normalizeFolder(workspace.folder) || rec.sessionId !== sid) {
      aliases.update(rec.id, { folder: workspace.folder, sessionId: sid });
    }
  }

  /** 当前别名的续聊脚本保鲜（绑定/会话演进/回答完成后调用；无别名或文件夹失效时静默跳过） */
  function refreshAliasScript(): void {
    if (!aliases || !workspace.currentAliasId) return;
    const rec = aliases.get(workspace.currentAliasId);
    if (!rec || !isValidFolder(rec.folder)) return;
    writeResumeScript(rec.folder, rec.name, sessions.get(rec.folder)?.sessionId ?? null);
  }

  /** 持久化工作区绑定（文件夹+当前别名）：桥接重启/升级后首个视图接入时据此恢复 */
  function persistWorkspace(): void {
    deps.workspaceStore?.save({ folder: workspace.folder, aliasId: workspace.currentAliasId });
  }

  /** 执行设置独立合并保存，hello 在 client.ready 前写入也不会清掉待恢复绑定 */
  function persistExecutionSettings(): void {
    const execution: WorkspaceExecutionSettings = {
      permissionMode: workspace.mode,
      model: workspace.model,
      effort: workspace.effort,
      fastMode: workspace.fastMode,
      fastRestore: cloneFastRestore(workspace.fastRestore),
    };
    deps.workspaceStore?.saveExecutionSettings(execution);
  }

  /**
   * 懒恢复工作区绑定：仅在工作区未绑定（桥接刚重启）且有持久化记录时执行。
   * 别名还在就按别名恢复（其 sessionId 为 null 时回退 sessions.json 映射续聊），否则按裸文件夹恢复；
   * 文件夹已失效则放弃（工作区保持未绑定，扩展侧 lastFolder 回绑兜底）。
   */
  function restoreWorkspaceIfIdle(): void {
    if (workspace.folder || !deps.workspaceStore) return;
    const b = deps.workspaceStore.load();
    if (!b) return;
    const alias = b.aliasId && aliases ? aliases.get(b.aliasId) : undefined;
    const folder = alias?.folder ?? b.folder;
    if (!folder || !isValidFolder(folder)) return;
    if (alias) workspace.currentAliasId = alias.id;
    bindFolder(folder, alias ? (alias.sessionId ?? undefined) : undefined, false); // 恢复不是主动换绑
  }

  function resetInflight(
    outcome: "cancelled" | "error" = "cancelled",
    decider: "abort" | "close" | "system" = "system",
    clearConversation = false,
  ): void {
    settleAllInteractions(outcome, decider);
    workspace.busy = false;
    workspace.streamText = "";
    workspace.inflightUser = null;
    workspace.pendingPerm = null;
    workspace.pendingAsk = null;
    workspace.pendingInteractions.clear();
    workspace.toolCalls.clear();
    workspace.timeline = [];
    workspace.sidecarPending = [];
    if (clearConversation) workspace.interactions = [];
    workspace.compacting = false; // 轮次异常终结：压缩提示不悬挂
    workspace.requesting = false; // 请求中同属瞬时状态，任何终结路径都清除
  }

  /** 为当前文件夹创建（或重建）Claude 会话；事件一律广播并记账到工作区（快照数据源） */
  function openSession(resumeId?: string): void {
    if (!workspace.folder) return;
    const f = workspace.folder;
    const epoch = ++workspace.sessionEpoch;
    const isCurrent = (): boolean => workspace.sessionEpoch === epoch && workspace.folder === f;
    const replacing = workspace.claude !== null;
    workspace.fastRollback = currentFastSnapshot(); // 新 Query 启动设置成为后续运行时切换的完整回滚基线
    workspace.fastRollbackSeq = workspace.fastRequestSeq;
    workspace.runtime = {}; // 新 Query 尚无真值；是否清扩展缓存由 runtimeAuthoritative 明确区分
    workspace.compacting = false; // 新 Query 不继承旧会话的压缩提示
    workspace.requesting = false; // 新 Query 不继承旧会话的请求中提示
    if (replacing) workspace.runtimeAuthoritative = true; // 主动替换旧 Query：空快照也是权威失效通知
    workspace.claude = newSession(f, {
      resumeId,
      permissionMode: workspace.mode,
      model: workspace.model,
      effort: workspace.effort,
      fastMode: workspace.fastMode,
      events: {
        onDelta: (text) => {
          if (!isCurrent()) return;
          workspace.streamText += text; // 真流式：每个 delta 立即广播一帧，同时记账供快照补齐
          const last = workspace.timeline[workspace.timeline.length - 1];
          if (last?.role === "assistant") last.text += text;
          else workspace.timeline.push({
            id: `assistant-${Date.now()}-${randomBytes(4).toString("hex")}`,
            createdAt: Date.now(), role: "assistant", text,
          });
          broadcast({ type: "chat.delta", text });
        },
        onTool: (name, summary, toolUseId, input) => {
          if (!isCurrent()) return;
          // 完整计划和计划文件由专用审批卡/只读决定展示，不再重复一行原始参数。
          if (name === "ExitPlanMode") return;
          const detail = input === undefined ? undefined : JSON.stringify(input, null, 2);
          if (toolUseId) workspace.toolCalls.set(toolUseId, { name, summary, ...(detail !== undefined ? { input: detail } : {}) });
          const old = toolUseId ? workspace.timeline.find((item) => item.toolUseId === toolUseId) : undefined;
          if (old) {
            Object.assign(old, {
              toolName: name, text: summary, toolStatus: "running",
              ...(detail !== undefined ? { toolInput: detail } : {}),
            });
          } else {
            workspace.timeline.push({
              id: toolUseId ? `tool-${toolUseId}` : `tool-${Date.now()}-${randomBytes(4).toString("hex")}`,
              createdAt: Date.now(), role: "tool", toolName: name, text: summary,
              ...(toolUseId ? { toolUseId, toolStatus: "running" as const } : {}),
              ...(detail !== undefined ? { toolInput: detail } : {}),
            });
          }
          broadcast({
            type: "chat.tool", name, summary,
            ...(toolUseId ? { toolUseId, status: "running" as const } : {}),
            ...(detail !== undefined ? { input: detail } : {}),
          });
        },
        onToolResult: ({ toolUseId, output, isError }) => {
          if (!isCurrent()) return;
          // Ask/计划已由只读交互记录完整呈现；tool_result 不再广播成缺少名称的通用工具活动。
          if (workspace.interactions.some((item) =>
            (item.kind === "ask" || item.kind === "exit_plan") && item.toolUseId === toolUseId
          )) return;
          const call = workspace.toolCalls.get(toolUseId) ?? { name: "tool", summary: "" };
          const status = isError ? "error" as const : "success" as const;
          const old = workspace.timeline.find((item) => item.toolUseId === toolUseId);
          if (old) Object.assign(old, { toolStatus: status, toolOutput: output });
          else workspace.timeline.push({
            id: `tool-${toolUseId}`, createdAt: Date.now(), role: "tool",
            toolName: call.name, text: call.summary, toolUseId, toolStatus: status, toolOutput: output,
          });
          broadcast({ type: "chat.tool", name: call.name, summary: call.summary, toolUseId, status, output });
        },
        onNotice: (notice) => {
          if (!isCurrent()) return;
          pushTimelineStatus(notice.text, {
            ...(notice.id ?? notice.toolUseId ? { id: notice.id ?? `status-permission-${notice.toolUseId}` } : {}),
            ...(notice.detail !== undefined ? { detail: notice.detail } : {}),
            ...(notice.role ? { role: notice.role } : {}),
          });
        },
        onRequesting: (requesting) => {
          if (!isCurrent()) return;
          workspace.requesting = requesting;
          broadcast({ type: "chat.requesting", requesting });
        },
        onCompact: (ev) => {
          if (!isCurrent()) return;
          workspace.compacting = ev.phase === "start";
          if (ev.phase === "done") {
            const text = ev.result === "failed"
              ? `⚠️ 上下文压缩失败${ev.error ? `：${ev.error}` : ""}，继续使用当前上下文`
              : compactBoundaryText(ev);
            const sessionId = sessions.get(f)?.sessionId;
            // 复用转录按 anchorUuid 关联的摘要，让实时记录与重载后的同一压缩保留相同折叠详情。
            const detail = ev.result === "success" && sessionId
              ? readHistoryPage(f, sessionId, { limit: 200 }).messages
                .filter((item) => item.text === text && item.detail).at(-1)?.detail
              : undefined;
            pushTimelineStatus(text, { ...(detail ? { detail } : {}) });
            broadcast({ type: "chat.compact", ...ev, recorded: true });
          } else {
            broadcast({ type: "chat.compact", ...ev });
          }
        },
        onRuntime: (info) => {
          if (!isCurrent()) return;
          setRuntime(info);
          broadcast(settingsStateMsg(true));
        },
        onDone: (sessionId, info) => {
          if (!isCurrent()) return;
          settleAllInteractions("cancelled", "system"); // 正常结束时仍未解决的回调不能无声消失
          if (info) setRuntime(info); // onRuntime 已即时上报；这里兜底快照数据源并兼容测试事件
          // info 字段为 undefined 时 JSON 序列化自动省略；effort 为 null 时显式下发（表示该会话无 effort 参数）
          const doneFast = info?.fast && (!workspace.fastPending || info.fastFresh === true) ? info.fast : undefined;
          flushSidecar(f, sessionId); // 即使 init 的会话 ID 事件缺席，也不能丢掉本轮已暂存事实
          if (workspace.requesting) {
            workspace.requesting = false;
            broadcast({ type: "chat.requesting", requesting: false });
          }
          broadcast({ type: "chat.done", sessionId, model: info?.model, effort: info?.effort, fast: doneFast, compacted: info?.compacted });
          workspace.busy = false;
          workspace.streamText = "";
          workspace.inflightUser = null;
          workspace.pendingPerm = null;
          workspace.pendingAsk = null;
          workspace.pendingInteractions.clear();
          workspace.toolCalls.clear();
          workspace.timeline = [];
          if (workspace.folder === f) {
            pushSessionList(); // 一轮结束后转录已落盘，刷新列表（新会话此刻才有文件）
            refreshAliasScript(); // 续聊脚本跟上最新会话
          }
        },
        onError: (message) => {
          if (!isCurrent()) return;
          pushTimelineStatus(`⚠️ ${message}`, { role: "assistant" });
          broadcast({ type: "chat.error", message, recorded: true });
          resetInflight("error", "system"); // 轮次终结：错误记录保留，后续快照不再补这轮
        },
        onAborted: () => {
          if (!isCurrent()) return;
          pushTimelineStatus("⏹ 已手动停止本轮生成", { role: "assistant" });
          broadcast({ type: "chat.aborted", recorded: true });
          resetInflight("cancelled", "abort"); // 用户停止：挂起交互逐项留下已取消记录
        },
        onInteractionSettled: ({ requestId, outcome, decider }) => {
          if (!isCurrent()) return;
          settleInteraction(requestId, outcome, { decider });
        },
        onPermission: (r) => {
          if (!isCurrent()) return;
          workspace.pendingPerm = r;
          workspace.pendingInteractions.set(r.requestId, {
            requestId: r.requestId,
            kind: r.kind ?? (r.tool === "ExitPlanMode" ? "exit_plan" : "permission"),
            tool: r.tool,
            detail: r.detail,
            ...(r.summary ? { summary: r.summary } : {}),
            ...(r.plan !== undefined ? { plan: r.plan } : {}),
            ...(r.planFilePath ? { planFilePath: r.planFilePath } : {}),
            ...(r.toolUseId ? { toolUseId: r.toolUseId } : {}),
            createdAt: Date.now(),
          });
          broadcast({ type: "permission.request", ...r });
        },
        onAsk: (r) => {
          if (!isCurrent()) return;
          workspace.pendingAsk = r;
          workspace.pendingInteractions.set(r.requestId, {
            requestId: r.requestId,
            kind: "ask",
            questions: r.questions,
            ...(r.toolUseId ? { toolUseId: r.toolUseId } : {}),
            createdAt: Date.now(),
          });
          broadcast({ type: "chat.ask", ...r });
        },
        onElicitation: (r) => {
          if (!isCurrent()) return;
          const request: InteractionRequest = { ...r, createdAt: Date.now() };
          workspace.pendingInteractions.set(r.requestId, request);
          broadcast({ type: "chat.interaction", request });
        },
        onUserDialog: (r) => {
          if (!isCurrent()) return;
          const request: InteractionRequest = { ...r, createdAt: Date.now() };
          workspace.pendingInteractions.set(r.requestId, request);
          broadcast({ type: "chat.interaction", request });
        },
        onElicitationComplete: ({ serverName, elicitationId }) => {
          if (!isCurrent()) return;
          const record = workspace.interactions.find((item) => item.kind === "elicitation"
            && item.elicitation?.serverName === serverName
            && item.elicitation.elicitationId === elicitationId);
          if (!record || record.elicitationComplete) return;
          record.elicitationComplete = true; // 更新原记录，不新增一条重复时间线。
          const item = workspace.timeline.find((entry) => entry.id === `interaction-${record.requestId}`);
          if (item) {
            item.interaction = record;
            persistTimelineItem(item);
          }
          broadcast({ type: "chat.interaction.resolved", requestId: record.requestId, record });
        },
        onSessionId: (id) => {
          if (!isCurrent()) return;
          const existing = sessions.get(f);
          sessions.set(f, {
            sessionId: id,
            title: existing?.title ?? "(新会话)",
            updatedAt: new Date().toISOString(),
          });
          flushSidecar(f, id);
          refreshAliasScript(); // 会话 ID 落地即有可续目标
          if (workspace.folder === f) {
            // 新会话 ID 写回当前别名（null 只是暂态）：再选该别名续聊此会话而非误开新会话
            syncCurrentAlias();
            pushAliasList();
          }
        },
      },
    });
    if (replacing) broadcast(settingsStateMsg(true)); // 新建/切换/普通重建：全部视图立即丢弃旧 Query 真值
  }

  /**
   * 绑定文件夹并重建会话（folder.bind 与 alias.select/create 共用）；p 需已通过 isValidFolder 校验。
   * @param p 目标文件夹
   * @param forceSessionId 别名指定的会话：string=续聊该会话（已删则退回新会话），null=强制新会话；缺省=按 sessions.json 映射走
   */
  function bindFolder(p: string, forceSessionId?: string | null, reset = true): void {
    void workspace.claude?.close();
    resetInflight("cancelled", "close", true); // 先在旧文件夹/旧会话结算，再改绑定，侧车不会串到新工作区
    workspace.folder = p;
    if (forceSessionId === undefined) {
      const rec = sessions.get(workspace.folder);
      openSession(rec?.sessionId);
      broadcast({ type: "folder.bound", ...(reset ? { reset: true } : {}), path: workspace.folder, resumed: Boolean(rec), title: rec?.title ?? "", sessionId: rec?.sessionId ?? null });
    } else if (forceSessionId === null) {
      sessions.delete(workspace.folder); // 别名指向"新会话"：清掉映射，下一条消息开全新会话
      openSession(undefined);
      broadcast({ type: "folder.bound", ...(reset ? { reset: true } : {}), path: workspace.folder, resumed: false, title: "", sessionId: null });
    } else {
      const target = listSessions(workspace.folder).find((s) => s.sessionId === forceSessionId);
      if (target) {
        sessions.set(workspace.folder, { sessionId: target.sessionId, title: target.title, updatedAt: new Date(target.updatedAt).toISOString() });
        openSession(target.sessionId);
        broadcast({ type: "folder.bound", ...(reset ? { reset: true } : {}), path: workspace.folder, resumed: true, title: target.title, sessionId: target.sessionId });
      } else {
        // 别名指向的会话已被删除：退回新会话，别名的 sessionId 由 syncCurrentAlias 顺带修正
        sessions.delete(workspace.folder);
        openSession(undefined);
        broadcast({ type: "folder.bound", ...(reset ? { reset: true } : {}), path: workspace.folder, resumed: false, title: "", sessionId: null });
        broadcast({ type: "folder.error", message: `会话 ${forceSessionId} 在该文件夹下没有转录，已改为开新会话` }); // 必须在 folder.bound 之后发：客户端收 bound 会清屏，先发警告会被抹掉
      }
    }
    pushSessionList();
    syncCurrentAlias();
    pushAliasList();
    refreshAliasScript();
    persistWorkspace();
  }

  /**
   * client.ready 快照推送（新视图/重连视图接入）。顺序保证：绑定态 → 历史回放 → 会话/别名列表 → 在途状态；
   * chat.sync 最后到达，在途用户气泡与流式文本追加在回放之上，不被回放替换抹掉。
   * @param send 目标连接的发送函数（快照只发请求方，不广播）
   */
  function pushSnapshot(send: (m: ServerMessage) => void): void {
    let snapshotTimeline = workspace.timeline;
    if (workspace.folder) {
      const rec = sessions.get(workspace.folder);
      send({ type: "folder.bound", path: workspace.folder, resumed: Boolean(rec), title: rec?.title ?? "", sessionId: rec?.sessionId ?? null });
      if (rec) {
        const history = readHistoryPage(workspace.folder, rec.sessionId);
        send({ type: "session.history.data", ...history });
        // 用户转录可能已落盘但在途轮尚未结束；用发送内容与时间证据去重，保留下一轮同文提问。
        const persistedUsers = history.messages.filter((item) => item.role === "user");
        snapshotTimeline = workspace.timeline.filter((item) => item.role !== "user" || !persistedUsers.some((old) =>
          old.text === item.text
          && (old.sentText ?? old.text) === (item.sentText ?? item.text)
          && old.createdAt >= item.createdAt
        ));
      }
      const sl = sessionListMsg();
      if (sl) send(sl);
    }
    // 别名列表是全局数据（不依附文件夹绑定）：未绑定也必须下发，否则空工作区时别名下拉永空
    const al = aliasListMsg();
    if (al) send(al);
    send(settingsStateMsg(workspace.runtimeAuthoritative)); // 重启恢复省略空快照；主动重建后显式空快照清旧缓存
    send({
      type: "chat.sync",
      busy: workspace.busy,
      streamText: workspace.streamText,
      user: workspace.inflightUser,
      permReq: workspace.pendingPerm,
      askReq: workspace.pendingAsk,
      draft: workspace.draft,
      compacting: workspace.compacting,
      requesting: workspace.requesting,
      pendingInteractions: [...workspace.pendingInteractions.values()],
      interactions: workspace.interactions,
      timeline: snapshotTimeline,
    });
  }

  /**
   * folder.open：打开"当前别名.folder ?? 工作区.folder"，并先刷新该别名的续聊脚本。
   * 只回请求方（folder.opened / folder.error），不广播。
   * @param send 请求方发送函数
   */
  async function handleFolderOpen(send: (m: ServerMessage) => void): Promise<void> {
    try {
      const a = aliases && workspace.currentAliasId ? aliases.get(workspace.currentAliasId) : undefined;
      const target = a?.folder ?? workspace.folder;
      if (!target) {
        send({ type: "folder.error", message: "还没有绑定文件夹" });
        return;
      }
      if (!isValidFolder(target)) {
        send({ type: "folder.error", message: `文件夹已不存在: ${target}` });
        return;
      }
      const script = a ? writeResumeScript(a.folder, a.name, sessions.get(a.folder)?.sessionId ?? null) : null;
      if (await openFolderImpl(target)) send({ type: "folder.opened", path: target, script });
      else send({ type: "folder.error", message: `无法打开文件管理器: ${target}` });
    } catch (e) {
      send({ type: "folder.error", message: `打开文件夹失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** 工作区上下文：attachHandlers 只接线不持有状态，在线切端口后新 wss 复用同一工作区 */
  const ctx: HandlerCtx = {
    workspace,
    clients,
    broadcast,
    settleInteraction,
    settingsStateMsg,
    bindFolder,
    openSession,
    resetInflight,
    pushSnapshot,
    readHistoryPage,
    handleFolderOpen,
    deleteHistorySidecar,
    pushSessionList,
    pushAliasList,
    sessionListMsg,
    aliasListMsg,
    syncCurrentAlias,
    refreshAliasScript,
    persistWorkspace,
    currentFastSnapshot,
    applyFastSnapshot,
    persistExecutionSettings,
    restoreWorkspaceIfIdle,
  };

  /**
   * 在线切端口：先在新端口完成监听+自探测，全部成功后才拆旧服务——切换失败不影响现状。
   * 新旧服务同属一个进程（同一 instanceId、同一工作区），探测不会误判重复实例。
   * @param target 用户要切的端口
   * @returns 实际生效的端口（目标被无关程序占用时顺延）
   * @throws 候选端口耗尽，或目标被同配置的另一个桥接实例占用
   */
  async function rebind(target: number): Promise<number> {
    const candidates = Array.from({ length: 10 }, (_, i) => target + i).filter((p) => p <= 65535);
    let lastErr: unknown = null;
    for (const port of candidates) {
      if (port === current.port) return port; // 目标即当前端口：直接成功
      let r: Running;
      try {
        r = await listenOn(port, httpHandler);
      } catch (e) {
        lastErr = e;
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && (await selfVerify(port, config.token, instanceId)) === "duplicate") {
          throw duplicateError(port);
        }
        continue;
      }
      attachHandlers(r.wss, deps, instanceId, ctx);
      const verdict = await selfVerify(port, config.token, instanceId);
      if (verdict === "duplicate") {
        await closeRunning(r);
        throw duplicateError(port);
      }
      if (verdict === "foreign") {
        console.warn(`[ccc-bridge] 端口 ${port} 被其他程序占用，顺延到 ${port + 1}`);
        await closeRunning(r);
        continue;
      }
      const old = current;
      current = r;
      config.port = port; // 配置对象原地更新：托盘等持有方读到的就是新端口
      if (deps.configDir) saveConfig(config, deps.configDir); // 持久化：下次启动直接用新端口
      deps.onPortChanged?.(port);
      console.log(`[ccc-bridge] 端口已在线切换到 ${port}`);
      // 改端口的 POST 响应走旧服务发出，稍等它发完再拆旧服务（同时断开旧 WS 客户端）
      setTimeout(() => void closeRunning(old), 250).unref();
      return port;
    }
    throw new Error(`端口 ${target}~${Math.min(target + 9, 65535)} 均不可用${lastErr ? `（最后错误: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}）` : ""}`);
  }

  /** 普通 HTTP 请求入口（/config 设置页）；闭包引用 current，切换后新服务仍用同一入口 */
  const httpHandler: http.RequestListener = (req, res) => {
    void handleConfigRequest(req, res, {
      config,
      configDir: deps.configDir,
      getPort: () => current.port,
      rebind,
    });
  };

  /** 组装对外 API：getter 始终读 current，在线切换后调用方自动看到新实例 */
  function api(): StartedServer {
    return {
      get wss() {
        return current.wss;
      },
      get port() {
        return current.port;
      },
      setPort: rebind,
      close: async () => {
        await closeRunning(current); // 先断开全部视图连接
        await workspace.claude?.close(); // 桥接整体关停才终结会话（视图断开/在线切端口都不杀）
      },
    };
  }

  const base = config.port;
  const candidates = base === 0 ? [0] : Array.from({ length: 10 }, (_, i) => base + i);
  let lastErr: unknown = null;
  for (const port of candidates) {
    let r: Running;
    try {
      r = await listenOn(port, httpHandler);
    } catch (e) {
      lastErr = e;
      // 非 Windows 平台上 EADDRINUSE 可靠：这里也要探一下，撞到自己人照样报重复实例
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && (await selfVerify(port, config.token, instanceId)) === "duplicate") {
        throw duplicateError(port);
      }
      continue;
    }
    attachHandlers(r.wss, deps, instanceId, ctx);
    if (port === 0) {
      // 系统分配的临时端口不会被抢占，跳过探测
      current = r;
      return api();
    }
    const verdict = await selfVerify(port, config.token, instanceId);
    if (verdict === "duplicate") {
      await closeRunning(r);
      throw duplicateError(port);
    }
    if (verdict === "foreign") {
      console.warn(`[ccc-bridge] 端口 ${port} 被其他程序占用，顺延到 ${port + 1}`);
      await closeRunning(r);
      continue;
    }
    current = r;
    return api();
  }
  throw new Error(`端口 ${base}~${base + 9} 均不可用${lastErr ? `（最后错误: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}）` : ""}`);
}

/**
 * 在已监听的 wss 上注册连接处理（握手鉴权 + 消息分发）。
 * 会话与工作区状态全部在 ctx（startServer 组装）里：本函数只管"认证连接 ↔ 工作区"的接线，
 * 因此在线切端口换新 wss 时工作区原地续命。
 * @param wss 已监听的 WebSocketServer
 * @param deps 服务依赖（握手鉴权用 config；路由用 sessions/aliases/pickFolder）
 * @param instanceId 本进程实例 ID（auth.ok 携带，供自探测认亲）
 * @param ctx 工作区上下文（唯一工作区 + 连接集合 + 广播/快照等操作）
 */
function attachHandlers(wss: WebSocketServer, deps: ServerDeps, instanceId: string, ctx: HandlerCtx): void {
  const { config, sessions, aliases } = deps;
  const pickFolderImpl = deps.pickFolder ?? defaultPickFolder;
  const {
    workspace,
    clients,
    broadcast,
    settleInteraction,
    settingsStateMsg,
    bindFolder,
    openSession,
    resetInflight,
    pushSnapshot,
    readHistoryPage,
    handleFolderOpen,
    deleteHistorySidecar,
    pushSessionList,
    pushAliasList,
    sessionListMsg,
    aliasListMsg,
    syncCurrentAlias,
    refreshAliasScript,
    persistWorkspace,
    currentFastSnapshot,
    applyFastSnapshot,
    persistExecutionSettings,
    restoreWorkspaceIfIdle,
  } = ctx;

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    // Host 校验防 DNS rebinding
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
      ws.close(4403);
      return;
    }
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      ws.close(4404);
      return;
    }
    if (!tokenOk(url.searchParams.get("token") ?? "", config.token)) {
      ws.send(encode({ type: "auth.fail", reason: "token 无效" }));
      ws.close(4401);
      return;
    }
    // 自探测连接（probe=自己的实例 ID）跳过 Origin 校验：它来自本进程，没有扩展 Origin
    const selfProbe = url.searchParams.get("probe") === instanceId;
    const origin = req.headers.origin ?? "";
    // 无 Origin 头 = 非浏览器进程（selftest/探针/CLI），放行；浏览器 WS 必发 Origin，白名单只挡浏览器侧
    if (!selfProbe && origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      ws.send(encode({ type: "auth.fail", reason: `origin 不允许: ${origin}` }));
      ws.close(4403);
      return;
    }
    if (!selfProbe && config.allowedOrigins.length === 0) {
      console.warn("[ccc-bridge] 警告：未配置 allowedOrigins，开发模式放行 Origin:", origin || "(无)");
    }
    ws.send(encode({ type: "auth.ok", instance: instanceId }));
    clients.add(ws); // 自探测连接也会进集合：它从不发 client.ready 不拿快照，随即 terminate 由 close 摘除

    const send = (m: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(m));
    };
    let pickSeq = 0; // folder.pick 代际号：新请求使旧请求的迟到结果作废（每连接独立）
    let sawReady = false; // 旧客户端只在首个 ready 前发送无标记的自动完整设置
    let pendingLegacyHello: Extract<ClientMessage, { type: "settings.set" }> | null = null;
    let pendingLegacyTail: ClientMessage[] = []; // 候选后的交错帧：待候选身份判明后按原序释放

    ws.on("message", (raw) => {
      // 处理器内任何同步异常都不能逃出：会冒泡成 uncaughtException 打崩整个桥接进程
      // （v2026.10.21.7 秒断事故：SDK 初始化抛错 → 进程死 → WS 1006）。switch 体保持原缩进，避免整段重排刷屏 diff。
      try {
      const parsed = parseClientMessage(raw.toString());
      if (!parsed) return;
      const messages: ClientMessage[] = [];
      // 未初始化桥的首个完整帧直接播种；已初始化桥只有 ready 前最后一个旧完整帧可能是自动 hello。
      // 候选后的交错帧先排队：再出现候选时，前一个候选及尾巴都是离线显式流量，按原序释放。
      if (!sawReady && workspace.settingsInitialized && parsed.type === "settings.set"
        && parsed.hello !== true && parsed.fastOnly !== true && parsed.fields === undefined) {
        if (pendingLegacyHello) messages.push(pendingLegacyHello, ...pendingLegacyTail);
        pendingLegacyTail = [];
        pendingLegacyHello = parsed;
      } else if (pendingLegacyHello && parsed.type !== "client.ready") {
        pendingLegacyTail.push(parsed);
      } else {
        if (pendingLegacyHello) messages.push({ ...pendingLegacyHello, hello: true }, ...pendingLegacyTail);
        pendingLegacyHello = null;
        pendingLegacyTail = [];
        messages.push(parsed);
      }
      if (parsed.type === "client.ready") sawReady = true;
      for (const m of messages) {
      switch (m.type) {
        case "auth":
          break; // auth 已在握手完成
        case "client.ready":
          restoreWorkspaceIfIdle(); // 桥接重启后的首个接入视图：先恢复上次的工作区绑定再发快照
          pushSnapshot(send); // 镜像快照：新视图/重连视图一次性补齐工作区现状
          break;
        case "folder.bind": {
          if (!isValidFolder(m.path)) {
            send({ type: "folder.error", message: `路径不存在或不是文件夹: ${m.path}` });
            break;
          }
          bindFolder(m.path, undefined, m.reset !== false);
          break;
        }
        case "folder.pick": {
          const seq = ++pickSeq;
          void pickFolderImpl().then((p) => {
            if (seq === pickSeq) send({ type: "folder.picked", path: p }); // 只认最新一次请求的结果
          });
          break;
        }
        case "folder.open":
          void handleFolderOpen(send); // 内部自带 try/catch，且只回请求方
          break;
        case "chat.send": {
          if (!workspace.folder || !workspace.claude) {
            send({ type: "chat.error", message: "请先绑定文件夹" });
            break;
          }
          workspace.timeline = []; // 新一轮只保留本轮在途顺序；近期已解决交互另表保留用于历史去重
          workspace.toolCalls.clear();
          let text = m.text;
          if (m.uploads && m.uploads.length > 0) {
            // 先落盘到 <绑定文件夹>/copilotUploads，再把说明块拼在客户端原文之前（原文自带 [页面上下文]/[用户问题] 包装）
            const r = saveUploads(workspace.folder, m.uploads);
            for (const f of r.failed) broadcast({ type: "chat.error", message: `文件保存失败：${f.name}（${f.reason}）` });
            if (r.saved.length === 0) break; // 全部失败：错误已逐条上报，本次消息不发送
            const uploadSummary = `已保存 ${r.saved.length} 个文件至 ${UPLOAD_DIR}`;
            broadcast({ type: "chat.tool", name: "上传", summary: uploadSummary }); // 全部视图镜像上传结果
            workspace.timeline.push({
              id: `upload-${Date.now()}-${randomBytes(4).toString("hex")}`,
              createdAt: Date.now(), role: "tool", toolName: "上传", text: uploadSummary,
            });
            text = `${composeUploadNote(r.saved.map((s) => s.path))}\n\n${m.text}`;
          }
          const rec = sessions.get(workspace.folder);
          if (rec && rec.title === "(新会话)") {
            // 首条消息前 30 字作为会话标题（优先用户原始输入 display，不含桥接拼的包装与上传说明块）
            const title = (m.display ?? m.text).replace(/\s+/g, " ").slice(0, 30);
            if (title) sessions.set(workspace.folder, { ...rec, title, updatedAt: new Date().toISOString() });
          }
          const display = m.display ?? m.text;
          workspace.inflightUser = { display, sent: text };
          workspace.timeline.push({
            id: `user-${Date.now()}-${randomBytes(4).toString("hex")}`,
            createdAt: Date.now(), role: "user", text: display, sentText: text,
          });
          if (m.note) workspace.timeline.push({
            id: `note-${Date.now()}-${randomBytes(4).toString("hex")}`,
            createdAt: Date.now(), role: "tool", text: m.note, sentText: text,
          });
          workspace.busy = true;
          workspace.streamText = "";
          if (workspace.draft) {
            workspace.draft = ""; // 发送即清草稿：镜像到全部视图（含上报方，它的输入框已由发送动作清空）
            broadcast({ type: "chat.draft", text: "" });
          }
          // 回显上屏由桥接统一广播（含发送方视图）：双视图气泡天然一致，不再各自乐观上屏
          broadcast({ type: "chat.user", display, sent: text, ...(m.note ? { note: m.note } : {}) });
          try {
            workspace.claude.send(text);
          } catch (e) {
            resetInflight(); // 发送动作同步抛错：回滚在途状态，避免工作区卡死在 busy
            throw e; // 交给外层统一 catch 上报请求方
          }
          break;
        }
        case "chat.abort":
          workspace.claude?.abort();
          break;
        case "chat.draft":
          workspace.draft = m.text;
          broadcast({ type: "chat.draft", text: m.text }, ws); // 镜像到其它视图；不回显上报方（防光标被回包顶跳）
          break;
        case "permission.response": {
          const record = settleInteraction(m.requestId, m.allow ? "allowed" : "denied", {
            decider: "user", ...(m.feedback?.trim() ? { feedback: m.feedback.trim() } : {}),
          });
          if (record) workspace.claude?.respondPermission(m.requestId, m.allow, m.feedback?.trim() || undefined);
          break;
        }
        case "chat.ask.answer": {
          const record = settleInteraction(m.requestId, "answered", { answers: m.answers, decider: "user" });
          if (record) workspace.claude?.respondAsk(m.requestId, m.answers);
          break;
        }
        case "chat.interaction.respond": {
          const request = workspace.pendingInteractions.get(m.requestId);
          if (!request) break; // 迟到/重复响应不触碰新卡
          if (request.kind === "user_dialog" && request.userDialog) {
            const response = m.response;
            const action = response.action;
            if (action !== "retry_fallback" && action !== "edit_prompt" && action !== "continue"
              && action !== "interrupt" && action !== "cancelled") break;
            const valid = request.userDialog.dialogKind === "refusal_fallback_prompt"
              ? action === "retry_fallback" || action === "edit_prompt" || action === "cancelled"
              : action === "continue" || action === "interrupt" || action === "cancelled";
            if (!valid) break; // 不用另一种对话框的枚举伪造用户选择
            if (!workspace.claude?.respondUserDialog(m.requestId, { action })) break;
            settleInteraction(m.requestId, action === "cancelled" ? "cancelled" : "answered", {
              decider: "user", userDialogAction: action,
            });
            break;
          }
          if (request.kind !== "elicitation" || !request.elicitation) break;
          const responseMessage = m.response;
          if (responseMessage.action !== "accept" && responseMessage.action !== "decline"
            && responseMessage.action !== "cancel") break;
          const { action } = responseMessage;
          const content = "content" in responseMessage ? responseMessage.content : undefined;
          if (action !== "accept" && content !== undefined) {
            send({ type: "chat.error", message: "拒绝或取消 MCP 请求时不能携带表单内容" });
            break;
          }
          if (request.elicitation.mode === "url" && content !== undefined) {
            send({ type: "chat.error", message: "MCP 链接确认不需要表单内容" });
            break;
          }
          if (request.elicitation.mode === "form" && action === "accept") {
            const errors = validateElicitationContent(request.elicitation.fields ?? [], content ?? {});
            if (errors.length > 0) {
              send({ type: "chat.error", message: `MCP 表单未提交：${errors.join("；")}` });
              break;
            }
          }
          const response = {
            action,
            ...(request.elicitation.mode === "form" && action === "accept" ? { content: content ?? {} } : {}),
          };
          if (!workspace.claude?.respondElicitation(m.requestId, response)) {
            send({ type: "chat.error", message: "MCP 请求已失效，请等待新的请求" });
            break;
          }
          const outcome = action === "accept"
            ? request.elicitation.mode === "form" ? "answered" : "allowed"
            : action === "decline" ? "denied" : "cancelled";
          settleInteraction(m.requestId, outcome, {
            decider: "user", elicitationAction: action,
            ...(action === "accept" && content ? { submittedFields: Object.keys(content) } : {}),
          });
          break;
        }
        case "session.history": {
          if (!workspace.folder) break;
          const rec = sessions.get(workspace.folder);
          const page = rec ? readHistoryPage(workspace.folder, rec.sessionId, {
            ...(m.before !== undefined ? { before: m.before } : {}),
            ...(m.limit !== undefined ? { limit: m.limit } : {}),
          }) : { messages: [], hasMore: false };
          send({
            type: "session.history.data", ...page,
            ...(m.before !== undefined ? { before: m.before } : {}),
          });
          break;
        }
        case "session.list": {
          const sl = sessionListMsg();
          if (sl) send(sl); // 请求-应答型，只回请求方
          break;
        }
        case "session.new": {
          if (!workspace.folder) break;
          void workspace.claude?.close();
          resetInflight("cancelled", "close", true); // 旧会话取消记录先落旧侧车
          sessions.delete(workspace.folder); // 清掉映射：下一条消息走全新会话
          openSession(undefined);
          broadcast({ type: "folder.bound", reset: true, path: workspace.folder, resumed: false, title: "", sessionId: null });
          pushSessionList();
          syncCurrentAlias();
          pushAliasList();
          refreshAliasScript();
          break;
        }
        case "session.switch": {
          if (!workspace.folder) break;
          const target = listSessions(workspace.folder).find((s) => s.sessionId === m.sessionId);
          if (!target) {
            send({ type: "folder.error", message: `会话不存在: ${m.sessionId}` });
            break;
          }
          void workspace.claude?.close();
          resetInflight("cancelled", "close", true); // 先结算到旧 sessionId，再切换到目标会话
          sessions.set(workspace.folder, { sessionId: target.sessionId, title: target.title, updatedAt: new Date(target.updatedAt).toISOString() });
          openSession(target.sessionId);
          broadcast({ type: "folder.bound", reset: true, path: workspace.folder, resumed: true, title: target.title, sessionId: target.sessionId });
          pushSessionList();
          syncCurrentAlias();
          pushAliasList();
          refreshAliasScript();
          break;
        }
        case "session.delete": {
          if (!workspace.folder) break;
          const wasCurrent = sessions.get(workspace.folder)?.sessionId === m.sessionId;
          deleteTranscript(workspace.folder, m.sessionId);
          deleteHistorySidecar(workspace.folder, m.sessionId);
          if (wasCurrent) {
            // 删的是当前会话：关会话、清映射，回到"未开始"状态
            void workspace.claude?.close();
            sessions.delete(workspace.folder);
            resetInflight("cancelled", "close", true);
            openSession(undefined);
            broadcast({ type: "folder.bound", reset: true, path: workspace.folder, resumed: false, title: "", sessionId: null });
          }
          pushSessionList();
          syncCurrentAlias();
          pushAliasList();
          refreshAliasScript();
          break;
        }
        case "alias.list": {
          const al = aliasListMsg();
          if (al) send(al); // 请求-应答型，只回请求方
          break;
        }
        case "alias.create": {
          if (!aliases) break;
          if (!isValidFolder(m.folder)) {
            send({ type: "folder.error", message: `路径不存在或不是文件夹: ${m.folder}` });
            break;
          }
          const rec = aliases.create(m.name, m.folder, m.sessionId, m.pageRichness);
          workspace.currentAliasId = rec.id; // 新别名立即成为当前：创建即绑定
          bindFolder(rec.folder, rec.sessionId); // 内含列表广播与续聊脚本保鲜
          break;
        }
        case "alias.select": {
          if (!aliases) break;
          const a = aliases.get(m.id);
          if (!a) {
            send({ type: "folder.error", message: `别名不存在: ${m.id}` });
            break;
          }
          if (!isValidFolder(a.folder)) {
            send({ type: "folder.error", message: `别名「${a.name}」的文件夹已不存在: ${a.folder}` });
            break;
          }
          workspace.currentAliasId = a.id;
          // 别名 sessionId 为 null = "还没定下会话"（不是"永远新开"）：回退 sessions.json 映射续聊，
          // 避免每次选中都删掉文件夹现有会话映射开新会话（弹窗自动选中路径每次打开都会走这里）
          bindFolder(a.folder, a.sessionId ?? undefined, m.reset !== false);
          break;
        }
        case "alias.update": {
          if (!aliases) break;
          const before = aliases.get(m.id);
          aliases.update(m.id, { name: m.name, folder: m.folder, sessionId: m.sessionId, pageRichness: m.pageRichness });
          // 改名/换文件夹时清掉旧位置的续聊脚本（防孤儿脚本）；当前别名随即在新位置重写
          if (before && ((m.name !== undefined && m.name !== before.name) || (m.folder !== undefined && m.folder !== before.folder))) {
            removeResumeScript(before.folder, before.name);
            if (workspace.currentAliasId === m.id) refreshAliasScript();
          }
          // 只改数据不重绑：换文件夹/会话的实际行为走 folder.bind/session.switch，粘性同步会写回别名
          pushAliasList();
          break;
        }
        case "alias.delete": {
          if (!aliases) break;
          const rec = aliases.get(m.id);
          aliases.delete(m.id);
          if (rec) removeResumeScript(rec.folder, rec.name); // 续聊脚本随别名走（仅删带生成标记的，防误删用户文件）
          if (workspace.currentAliasId === m.id) workspace.currentAliasId = null; // 只删别名：会话、转录、当前绑定全部不动
          pushAliasList();
          persistWorkspace(); // 当前别名被删：持久化绑定里的 aliasId 同步清掉
          break;
        }
        case "settings.set": {
          if (m.hello === true && workspace.settingsInitialized) break; // 自动 hello 只播种未初始化桥
          const seeding = !workspace.settingsInitialized;
          const fastOnly = m.fastOnly === true && !seeding; // 未初始化时 fastOnly 仍是完整播种
          const fields = seeding ? undefined : m.fields;
          const includesField = (field: "permissionMode" | "model" | "effort" | "fastMode"): boolean => fields === undefined || fields.includes(field);
          const previous = currentFastSnapshot();
          const modelIntent = !fastOnly && includesField("model");
          const candidateModel = modelIntent ? m.model : previous.model;
          const nextFast = (fastOnly || includesField("fastMode")) ? m.fastMode ?? previous.fastMode : previous.fastMode;
          const fastChanged = nextFast !== previous.fastMode;
          const promoting = !seeding && !previous.fastMode && nextFast;
          const demoting = !seeding && previous.fastMode && !nextFast;
          const restoreBefore = cloneFastRestore(previous.fastRestore);
          let requestSnapshot: FastExecutionSnapshot;

          // 先由旧状态与字段意图计算完整目标，再一次性提交，避免模型和恢复基线分别漂移。
          if (seeding) {
            requestSnapshot = {
              fastMode: nextFast,
              model: candidateModel,
              ...(nextFast ? { fastRestore: restoreBefore ?? { request: candidateModel ?? null } } : {}),
            };
          } else if (promoting) {
            requestSnapshot = {
              fastMode: true,
              model: "opus",
              fastRestore: { request: candidateModel ?? null },
            };
          } else if (nextFast) {
            requestSnapshot = {
              fastMode: true,
              model: candidateModel,
              fastRestore: modelIntent
                ? { request: candidateModel ?? null }
                : restoreBefore ?? { request: previous.model ?? null },
            };
          } else if (demoting && !modelIntent) {
            const restore: FastRestoreBaseline = restoreBefore ?? { request: previous.model ?? null };
            let restoredModel: string | undefined;
            if (restore.request !== null) restoredModel = restore.request;
            else if (previous.model !== undefined && workspace.claude) restoredModel = restore.actualModel;
            requestSnapshot = { fastMode: false, model: restoredModel };
          } else {
            requestSnapshot = { fastMode: nextFast, model: candidateModel };
          }

          // 普通模型变化按用户候选值判断；仅由 fast 带来的 Opus 提升/恢复不得触发重建。
          const ordinaryModelChanged = modelIntent && candidateModel !== previous.model;
          const rebuildChanged = !fastOnly && (
            (includesField("permissionMode") && m.permissionMode !== workspace.mode)
            || ordinaryModelChanged
            || (includesField("effort") && m.effort !== workspace.effort)
          );
          const previousRuntime = workspace.runtime;
          const previousFastPending = workspace.fastPending;
          if (!fastOnly) {
            if (includesField("permissionMode")) workspace.mode = m.permissionMode;
            if (includesField("effort")) workspace.effort = m.effort;
          }
          applyFastSnapshot(requestSnapshot);
          workspace.settingsInitialized = true;
          persistExecutionSettings();

          let nativeModel: string | null | undefined;
          let readAutoAfterOn = false;
          let readAutoAfterOff = false;
          let offFallbackModel: string | undefined;
          if (promoting) {
            nativeModel = "opus";
            readAutoAfterOn = requestSnapshot.fastRestore?.request === null;
          } else if (demoting && !modelIntent) {
            const restore: FastRestoreBaseline = restoreBefore ?? { request: previous.model ?? null };
            if (restore.request !== null) {
              nativeModel = restore.request === previous.model ? undefined : restore.request;
            } else if (previous.model !== undefined) {
              if (restore.actualModel) nativeModel = restore.actualModel;
              else {
                nativeModel = null; // 会话内部等待同一串行链的自动快照，原生层绝不会收到 null
                readAutoAfterOff = true;
                offFallbackModel = previous.model;
              }
            }
          }

          if (rebuildChanged) {
            workspace.fastRequestSeq += 1; // 普通重建使旧 fast 完成结果全部失效
            workspace.fastRollback = cloneFastSnapshot(requestSnapshot);
            workspace.fastRollbackSeq = workspace.fastRequestSeq;
            if (workspace.folder && workspace.claude) {
              if (workspace.busy) broadcast({ type: "chat.aborted" });
              resetInflight();
              const rec = sessions.get(workspace.folder);
              void workspace.claude.close();
              openSession(rec?.sessionId);
            } else {
              broadcast(settingsStateMsg(workspace.runtimeAuthoritative));
            }
          } else if (fastChanged) {
            // fast-only 保留 Query 和 busy/inflight；后续请求才由 CC 应用并回报真值。
            const session = workspace.claude;
            const previousRuntimeAuthoritative = workspace.runtimeAuthoritative;
            workspace.fastPending = true;
            if (session) workspace.runtime = { ...workspace.runtime };
            if (session) delete workspace.runtime.fast;
            const pendingRuntime = workspace.runtime;
            const requestSeq = ++workspace.fastRequestSeq;
            broadcast(settingsStateMsg(workspace.runtimeAuthoritative));
            if (session) {
              void Promise.resolve()
                .then(() => nativeModel === undefined
                  ? session.setFastMode(nextFast)
                  : session.setFastMode(nextFast, nativeModel))
                .then(async () => {
                  if (workspace.claude !== session) return;
                  const accepted = cloneFastSnapshot(requestSnapshot);
                  let actualModel: string | undefined;
                  if (readAutoAfterOn || readAutoAfterOff) {
                    try {
                      actualModel = await session.fastAutoModel();
                    } catch {
                      actualModel = undefined; // 未公开元数据失败不改变原生控制已接受的事实
                    }
                    if (workspace.claude !== session) return;
                  }
                  if (nextFast && workspace.fastRequestSeq === requestSeq) {
                    // 在途期间的同值模型意图只改恢复基线，成功回包不得覆盖这份更新的本地状态。
                    accepted.fastRestore = cloneFastRestore(workspace.fastRestore);
                  }
                  if (readAutoAfterOn && actualModel && accepted.fastRestore?.request === null) {
                    accepted.fastRestore = { request: null, actualModel };
                  }
                  let restoreWarning = false;
                  if (readAutoAfterOff) {
                    accepted.model = actualModel ?? offFallbackModel;
                    restoreWarning = actualModel === undefined;
                  }
                  // 控制接受只更新请求回滚基线，不代表 CC 实际 fast 已变化。
                  if (requestSeq >= workspace.fastRollbackSeq) {
                    workspace.fastRollback = cloneFastSnapshot(accepted);
                    workspace.fastRollbackSeq = requestSeq;
                  }
                  if (workspace.fastRequestSeq === requestSeq) {
                    const visibleBefore = currentFastSnapshot();
                    const snapshotChanged = !sameFastSnapshot(visibleBefore, accepted);
                    if (snapshotChanged) {
                      applyFastSnapshot(accepted);
                      persistExecutionSettings();
                      if (visibleBefore.model !== accepted.model || visibleBefore.fastMode !== accepted.fastMode) {
                        broadcast(settingsStateMsg(workspace.runtimeAuthoritative));
                      }
                    }
                    if (restoreWarning) {
                      broadcast({ type: "settings.error", message: "fast 已关闭，但开启前自动档实际模型未知，未猜测恢复模型；已保留当前模型" });
                    }
                  }
                })
                .catch((e: unknown) => {
                  // 只有同 Query 的最新失败可回滚；不得释放当前轮次或伪造 CC 真值。
                  if (workspace.claude !== session || workspace.fastRequestSeq !== requestSeq) return;
                  applyFastSnapshot(workspace.fastRollback);
                  workspace.fastRollbackSeq = requestSeq;
                  workspace.fastPending = workspace.runtime.fast ? false : previousFastPending;
                  persistExecutionSettings();
                  if (workspace.runtime === pendingRuntime) {
                    workspace.runtime = previousRuntime;
                    workspace.runtimeAuthoritative = previousRuntimeAuthoritative;
                  }
                  broadcast(settingsStateMsg(workspace.runtimeAuthoritative));
                  broadcast({ type: "settings.error", message: "原生 fast 设置失败: " + (e instanceof Error ? e.message : String(e)) });
                });
            } else {
              workspace.fastRollback = cloneFastSnapshot(requestSnapshot);
              workspace.fastRollbackSeq = requestSeq;
            }
          } else {
            if (!sameFastSnapshot(previous, requestSnapshot)
              && workspace.fastRollbackSeq === workspace.fastRequestSeq) {
              // 无在途控制时，本地基线修改直接成为回滚快照；在途请求仍须保留失败处理资格。
              workspace.fastRollback = cloneFastSnapshot(requestSnapshot);
            }
            broadcast(settingsStateMsg());
          }
          break;
        }
      }
      }
      } catch (e) {
        // 会话创建/重建等同步异常（如 CLI 路径解析失败）：告知侧栏并保活，进程与连接都不死
        console.error("[ccc-bridge] 消息处理异常:", e);
        send({ type: "chat.error", message: `桥接内部错误: ${e instanceof Error ? e.message : String(e)}` });
      }
    });

    ws.on("close", () => {
      clients.delete(ws); // 视图断开只摘连接：会话随工作区活，桥接进程退出才终结（StartedServer.close）
    });
  });
}
