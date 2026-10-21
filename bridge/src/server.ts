/** ccc-bridge 服务端：WS 桥（握手鉴权 + 会话管理）+ 内置 /config 端口设置页（在线改端口）。 */
import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { encode, parseClientMessage, type PermissionModeSetting, type EffortLevelSetting, type ServerMessage } from "./protocol";
import { isValidFolder, SessionManager } from "./session-manager";
import { createClaudeSession, type ClaudeSessionLike } from "./claude-session";
import { readTranscript, listSessions, deleteTranscript } from "./transcript";
import { saveConfig, type BridgeConfig } from "./config";
import { encodePairing } from "./pairing";

/** 服务依赖。createSession 仅供测试注入假会话工厂。 */
export interface ServerDeps {
  config: BridgeConfig;
  sessions: SessionManager;
  createSession?: typeof createClaudeSession;
  /** 配置目录：在线改端口后把新端口写回 config.json；缺省时 /config 只允许查看、保存返回 503（测试模式） */
  configDir?: string;
  /** 在线改端口成功后回调（托盘更新菜单文案、写 runtime.json） */
  onPortChanged?: (port: number) => void;
}

/** 启动结果：wss/port 始终指向当前实例（在线改端口后跟随），close 关闭当前实例，setPort 在线改端口 */
export interface StartedServer {
  /** 当前 WS 服务实例 */
  readonly wss: WebSocketServer;
  /** 当前实际监听的端口（config.port=0 时为系统分配） */
  readonly port: number;
  /**
   * 在线改端口：先在新端口完成监听+自探测，成功后才拆旧服务（含写回 config.json、触发 onPortChanged）。
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
<title>Claude Code 桥接 · 修改端口</title>
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
<h1>Claude Code 桥接 · 修改端口</h1>
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
 * @param deps 配置、会话映射、（测试用）会话工厂、配置目录与端口变更回调
 * @returns wss 实例、实际端口与关闭函数（均跟随在线切换后的当前实例）
 * @throws 候选端口耗尽，或发现重复实例
 */
export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const instanceId = randomBytes(8).toString("hex"); // 本进程实例 ID：自探测认亲用
  const { config } = deps;
  let current: Running; // 当前监听着的服务（在线改端口会整体替换）

  /**
   * 在线切端口：先在新端口完成监听+自探测，全部成功后才拆旧服务——切换失败不影响现状。
   * 新旧服务同属一个进程（同一 instanceId），探测不会误判重复实例。
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
      attachHandlers(r.wss, deps, instanceId);
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
      close: () => closeRunning(current),
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
    attachHandlers(r.wss, deps, instanceId);
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
 * 在已监听的 wss 上注册连接处理（握手鉴权 + 消息分发 + 会话管理）。
 * @param wss 已监听的 WebSocketServer
 * @param deps 服务依赖
 * @param instanceId 本进程实例 ID（auth.ok 携带，供自探测认亲）
 */
function attachHandlers(wss: WebSocketServer, deps: ServerDeps, instanceId: string): void {
  const { config, sessions } = deps;
  const newSession = deps.createSession ?? createClaudeSession;

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

    // 每连接状态
    let folder: string | null = null;
    let claude: ClaudeSessionLike | null = null;
    let mode: PermissionModeSetting = "auto";
    let model: string | undefined;
    let effort: EffortLevelSetting | undefined;

    const send = (m: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(m));
    };

    /** 推送当前文件夹的会话列表（currentId 取映射里的当前会话） */
    function sendSessionList(): void {
      if (!folder) return;
      send({
        type: "session.list.data",
        sessions: listSessions(folder),
        currentId: sessions.get(folder)?.sessionId ?? null,
      });
    }

    /** 为当前文件夹创建（或重建）Claude 会话 */
    function openSession(resumeId?: string): void {
      if (!folder) return;
      const f = folder;
      claude = newSession(f, {
        resumeId,
        permissionMode: mode,
        model,
        effort,
        events: {
          onDelta: (text) => send({ type: "chat.delta", text }),
          onTool: (name, summary) => send({ type: "chat.tool", name, summary }),
          onDone: (sessionId, info) => {
            // info 字段为 undefined 时 JSON 序列化自动省略；effort 为 null 时显式下发（表示该会话无 effort 参数）
            send({ type: "chat.done", sessionId, model: info?.model, effort: info?.effort, compacted: info?.compacted });
            if (folder === f) sendSessionList(); // 一轮结束后转录已落盘，刷新列表（新会话此刻才有文件）
          },
          onError: (message) => send({ type: "chat.error", message }),
          onPermission: (r) => send({ type: "permission.request", ...r }),
          onSessionId: (id) => {
            const existing = sessions.get(f);
            sessions.set(f, {
              sessionId: id,
              title: existing?.title ?? "(新会话)",
              updatedAt: new Date().toISOString(),
            });
          },
        },
      });
    }

    ws.on("message", (raw) => {
      const m = parseClientMessage(raw.toString());
      if (!m) return;
      switch (m.type) {
        case "auth":
        case "client.ready":
          break; // auth 已在握手完成；ready 是扩展点（预留消息闸门）
        case "folder.bind": {
          if (!isValidFolder(m.path)) {
            send({ type: "folder.error", message: `路径不存在或不是文件夹: ${m.path}` });
            break;
          }
          void claude?.close();
          folder = m.path;
          const rec = sessions.get(folder);
          openSession(rec?.sessionId);
          send({ type: "folder.bound", path: folder, resumed: Boolean(rec), title: rec?.title ?? "", sessionId: rec?.sessionId ?? null });
          sendSessionList();
          break;
        }
        case "chat.send": {
          if (!folder || !claude) {
            send({ type: "chat.error", message: "请先绑定文件夹" });
            break;
          }
          const rec = sessions.get(folder);
          if (rec && rec.title === "(新会话)") {
            // 首条消息前 30 字作为会话标题
            sessions.set(folder, { ...rec, title: m.text.replace(/\s+/g, " ").slice(0, 30), updatedAt: new Date().toISOString() });
          }
          claude.send(m.text);
          break;
        }
        case "chat.abort":
          claude?.abort();
          break;
        case "permission.response":
          claude?.respondPermission(m.requestId, m.allow);
          break;
        case "session.history": {
          if (!folder) break;
          const rec = sessions.get(folder);
          send({ type: "session.history.data", messages: rec ? readTranscript(folder, rec.sessionId) : [] });
          break;
        }
        case "session.list":
          sendSessionList();
          break;
        case "session.new": {
          if (!folder) break;
          void claude?.close();
          sessions.delete(folder); // 清掉映射：下一条消息走全新会话
          openSession(undefined);
          send({ type: "folder.bound", path: folder, resumed: false, title: "", sessionId: null });
          sendSessionList();
          break;
        }
        case "session.switch": {
          if (!folder) break;
          const target = listSessions(folder).find((s) => s.sessionId === m.sessionId);
          if (!target) {
            send({ type: "folder.error", message: `会话不存在: ${m.sessionId}` });
            break;
          }
          void claude?.close();
          sessions.set(folder, { sessionId: target.sessionId, title: target.title, updatedAt: new Date(target.updatedAt).toISOString() });
          openSession(target.sessionId);
          send({ type: "folder.bound", path: folder, resumed: true, title: target.title, sessionId: target.sessionId });
          sendSessionList();
          break;
        }
        case "session.delete": {
          if (!folder) break;
          const wasCurrent = sessions.get(folder)?.sessionId === m.sessionId;
          deleteTranscript(folder, m.sessionId);
          if (wasCurrent) {
            // 删的是当前会话：关会话、清映射，回到"未开始"状态
            void claude?.close();
            sessions.delete(folder);
            openSession(undefined);
            send({ type: "folder.bound", path: folder, resumed: false, title: "", sessionId: null });
          }
          sendSessionList();
          break;
        }
        case "settings.set": {
          const changed = m.permissionMode !== mode || m.model !== model || m.effort !== effort;
          mode = m.permissionMode;
          model = m.model;
          effort = m.effort;
          if (changed && folder && claude) {
            // 模式/模型/effort 变更需要重建会话（resumeId 保证上下文不断）
            const rec = sessions.get(folder);
            void claude.close();
            openSession(rec?.sessionId);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      void claude?.close();
    });
  });
}
