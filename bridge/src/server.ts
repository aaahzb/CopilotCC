import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { encode, parseClientMessage, type PermissionModeSetting, type ServerMessage } from "./protocol";
import { isValidFolder, SessionManager } from "./session-manager";
import { createClaudeSession, type ClaudeSessionLike } from "./claude-session";
import { readTranscript } from "./transcript";
import type { BridgeConfig } from "./config";

/** 服务依赖。createSession 仅供测试注入假会话工厂。 */
export interface ServerDeps {
  config: BridgeConfig;
  sessions: SessionManager;
  createSession?: typeof createClaudeSession;
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
 * 启动 WS 桥接服务。只绑 127.0.0.1；Host 头校验防 DNS rebinding；
 * token 认证；配置白名单后强制 Origin 校验。
 * @param deps 配置、会话映射、（测试用）会话工厂
 * @returns wss 实例与关闭函数
 */
export function startServer(deps: ServerDeps): { wss: WebSocketServer; close: () => Promise<void> } {
  const { config, sessions } = deps;
  const newSession = deps.createSession ?? createClaudeSession;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: config.port });

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
    const origin = req.headers.origin ?? "";
    if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      ws.send(encode({ type: "auth.fail", reason: `origin 不允许: ${origin}` }));
      ws.close(4403);
      return;
    }
    if (config.allowedOrigins.length === 0) {
      console.warn("[ccc-bridge] 警告：未配置 allowedOrigins，开发模式放行 Origin:", origin || "(无)");
    }
    ws.send(encode({ type: "auth.ok" }));

    // 每连接状态
    let folder: string | null = null;
    let claude: ClaudeSessionLike | null = null;
    let mode: PermissionModeSetting = "auto";

    const send = (m: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode(m));
    };

    /** 为当前文件夹创建（或重建）Claude 会话 */
    function openSession(resumeId?: string): void {
      if (!folder) return;
      const f = folder;
      claude = newSession(f, {
        resumeId,
        permissionMode: mode,
        events: {
          onDelta: (text) => send({ type: "chat.delta", text }),
          onTool: (name, summary) => send({ type: "chat.tool", name, summary }),
          onDone: (sessionId) => send({ type: "chat.done", sessionId }),
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
        case "settings.set": {
          const changed = m.permissionMode !== mode;
          mode = m.permissionMode;
          if (changed && folder && claude) {
            // 模式变更需要重建会话（resumeId 保证上下文不断）
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

  return { wss, close: () => new Promise<void>((r) => wss.close(() => r())) };
}
