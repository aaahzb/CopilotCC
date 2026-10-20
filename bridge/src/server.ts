import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { encode, parseClientMessage, type PermissionModeSetting, type EffortLevelSetting, type ServerMessage } from "./protocol";
import { isValidFolder, SessionManager } from "./session-manager";
import { createClaudeSession, type ClaudeSessionLike } from "./claude-session";
import { readTranscript, listSessions, deleteTranscript } from "./transcript";
import type { BridgeConfig } from "./config";

/** 服务依赖。createSession 仅供测试注入假会话工厂。 */
export interface ServerDeps {
  config: BridgeConfig;
  sessions: SessionManager;
  createSession?: typeof createClaudeSession;
}

/** 启动结果：wss 实例、实际端口（占用时会顺延）、关闭函数 */
export interface StartedServer {
  wss: WebSocketServer;
  /** 实际监听的端口（config.port=0 时为系统分配） */
  port: number;
  close: () => Promise<void>;
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
 * 监听指定端口，listening 才返回。
 * @param port 目标端口
 * @returns 已监听的 wss
 * @throws 监听失败（如 EADDRINUSE）时清理后拒绝
 */
function listen(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    wss.once("listening", () => resolve(wss));
    wss.once("error", (e: Error) => {
      wss.close();
      reject(e);
    });
  });
}

/** 关闭 wss 的 Promise 包装 */
function closeWss(wss: WebSocketServer): Promise<void> {
  return new Promise((r) => wss.close(() => r()));
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
 * 启动 WS 桥接服务（异步完成监听）。只绑 127.0.0.1；Host 头校验防 DNS rebinding；
 * token 认证；配置白名单后强制 Origin 校验。
 * 端口策略：config.port=0 时系统分配（测试/自检）；否则从配置端口起最多顺延 10 个，
 * 每个候选监听成功后做自探测——顺延只对"无关程序占用"生效；发现同 token 的重复实例直接抛错。
 * @param deps 配置、会话映射、（测试用）会话工厂
 * @returns wss 实例、实际端口与关闭函数
 * @throws 候选端口耗尽，或发现重复实例
 */
export async function startServer(deps: ServerDeps): Promise<StartedServer> {
  const instanceId = randomBytes(8).toString("hex"); // 本进程实例 ID：自探测认亲用
  const base = deps.config.port;
  const candidates = base === 0 ? [0] : Array.from({ length: 10 }, (_, i) => base + i);
  let lastErr: unknown = null;
  for (const port of candidates) {
    let wss: WebSocketServer;
    try {
      wss = await listen(port);
    } catch (e) {
      lastErr = e;
      // 非 Windows 平台上 EADDRINUSE 可靠：这里也要探一下，撞到自己人照样报重复实例
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && (await selfVerify(port, deps.config.token, instanceId)) === "duplicate") {
        throw duplicateError(port);
      }
      continue;
    }
    attachHandlers(wss, deps, instanceId);
    if (port === 0) {
      // 系统分配的临时端口不会被抢占，跳过探测
      return { wss, port: (wss.address() as AddressInfo).port, close: () => closeWss(wss) };
    }
    const verdict = await selfVerify(port, deps.config.token, instanceId);
    if (verdict === "duplicate") {
      await closeWss(wss);
      throw duplicateError(port);
    }
    if (verdict === "foreign") {
      console.warn(`[ccc-bridge] 端口 ${port} 被其他程序占用，顺延到 ${port + 1}`);
      await closeWss(wss);
      continue;
    }
    return { wss, port, close: () => closeWss(wss) };
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

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
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
    if (!selfProbe && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
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
          onDone: (sessionId) => {
            send({ type: "chat.done", sessionId });
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
