/**
 * WS 消息协议（单一来源）。修改本文件后运行 scripts/sync-protocol.mjs 同步到两端。
 * 消息命名：客户端 → 服务用动词（chat.send），服务 → 客户端用结果（chat.delta）。
 */

/** 权限模式设置：auto=自动审批分类器；approve-each=聊天内逐条审批卡片 */
export type PermissionModeSetting = "auto" | "acceptEdits" | "plan" | "approve-each";

/** 推理强度档位（对应 Agent SDK 的 EffortLevel） */
export type EffortLevelSetting = "low" | "medium" | "high" | "xhigh" | "max";

/** Claude Code 原生 fast 实际状态；cooldown 是 CC 因速率限制回报的冷却期 */
export type FastModeState = "off" | "cooldown" | "on";

/** Claude Code 原生 fast 不可用原因，不在 CopilotCC 自行扩展或推断 */
export type FastModeDisabledReason =
  | "free" | "preference" | "extra_usage_disabled" | "network_error" | "unknown"
  | "not_first_party" | "disabled_by_env" | "model_not_allowed" | "sdk_opt_in_required" | "pending";

/** CC 最近回报的 fast 真值；与用户持久化的请求开关相互独立 */
export interface FastModeRuntime {
  state: FastModeState;
  disabledReason?: FastModeDisabledReason;
}

/** CC init/result 最近确认的执行真值；缺字段表示没有新证据，不等于 off */
export interface ExecutionRuntime {
  model?: string;
  effort?: EffortLevelSetting | null;
  fast?: FastModeRuntime;
}

/** 历史回放消息；tool 复用实时工具活动行，不作为回答正文气泡 */
export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** 工具名或本地命令名；仅 role=tool 时有 */
  toolName?: string;
  /** 完整发送内容（已去防注入前缀）；仅桥接来源的用户消息有，供右键溯源 */
  sentText?: string;
  /** 附带标记：full=页面全文，selection=仅选中文字，upload=上传文件 */
  attachKind?: "full" | "selection" | "upload";
}

/** 会话列表项（一个文件夹下可有多个会话） */
export interface SessionInfo {
  sessionId: string;
  /** 标题：首条用户消息拆解包装后的前 30 字；无则 "(空会话)" */
  title: string;
  /** 转录文件 mtime，epoch 毫秒 */
  updatedAt: number;
}

/** 别名：文件夹+会话组合的命名快捷方式（桥接 aliases.json 持久化，扩展平时只显别名标签） */
export interface AliasInfo {
  id: string;
  name: string;
  folder: string;
  /** 绑定的会话 ID；null = 选中别名时在该文件夹开新会话 */
  sessionId: string | null;
  /** 页面信息丰富度（附带网页时注入正文的字符量档位）；未设置 = standard */
  pageRichness?: PageRichness;
}

/** 聊天随附的上传文件（base64 内容；桥接落盘到绑定文件夹的 copilotUploads 目录） */
export interface UploadFile {
  name: string;
  dataB64: string;
}

/** 单次上传文件数上限 */
export const MAX_UPLOAD_FILES = 10;
/** 单文件 base64 字符数上限（≈30MB 二进制） */
export const MAX_UPLOAD_B64_CHARS = 41_000_000;
/** 单次上传 base64 总字符数上限（≈45MB 二进制；ws 默认 100MiB 帧上限内留足余量） */
export const MAX_UPLOAD_TOTAL_B64 = 60_000_000;

/** settings.set 的显式变更字段；存在时未列出的完整快照字段仅供兼容，不得覆盖服务器 */
export type ExecutionSettingField = "permissionMode" | "model" | "effort" | "fastMode";

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "client.ready" }
  // reset=false 仅用于重连后的自动回绑；用户主动绑定缺省按 true 处理
  | { type: "folder.bind"; path: string; reset?: boolean }
  | { type: "folder.pick" }
  // chat.send：text=组装后的完整发送内容；display=用户原始输入（镜像视图上屏用，可空串=纯文件发送）；note=附带结果说明（随 chat.user 广播成 tool 泡）
  | { type: "chat.send"; text: string; display?: string; note?: string; uploads?: UploadFile[] }
  | { type: "chat.abort" }
  // chat.draft：输入框草稿上报（空串=清空；工作区持有并镜像到其它视图，逐键防抖发送，上限见 parse）
  | { type: "chat.draft"; text: string }
  | { type: "permission.response"; requestId: string; allow: boolean }
  | { type: "session.history" }
  | { type: "session.list" }
  | { type: "session.new" }
  | { type: "session.switch"; sessionId: string }
  | { type: "session.delete"; sessionId: string }
  | { type: "alias.list" }
  | { type: "alias.create"; name: string; folder: string; sessionId: string | null; pageRichness?: PageRichness }
  | { type: "alias.update"; id: string; name?: string; folder?: string; sessionId?: string | null; pageRichness?: PageRichness }
  | { type: "alias.delete"; id: string }
  | { type: "alias.select"; id: string; reset?: boolean }
  // folder.open：无参——服务端按"当前别名.folder ?? 工作区.folder"解析目标，客户端不传路径（杜绝任意路径打开）
  | { type: "folder.open" }
  // fastOnly=true 时只有 fastMode 是变更意图；其余完整字段仅供旧桥兼容，不得据旧值重建会话
  // hello=true 仅表示自动播种；已初始化桥必须忽略，手动用户操作不得携带
  | { type: "settings.set"; permissionMode: PermissionModeSetting; model?: string; effort?: EffortLevelSetting; fastMode?: boolean; fastOnly?: boolean; hello?: boolean; fields?: ExecutionSettingField[] };

export type ServerMessage =
  | { type: "auth.ok"; instance?: string }
  | { type: "auth.fail"; reason: string }
  // reset=true 仅用于主动换绑/新建/切换/删除；client.ready 快照省略，避免重连误清界面
  | { type: "folder.bound"; path: string; resumed: boolean; title: string; sessionId: string | null; reset?: boolean }
  | { type: "folder.error"; message: string }
  // folder.picked：系统文件夹选择框结果；path 为 null = 用户取消或平台不支持
  | { type: "folder.picked"; path: string | null }
  | { type: "chat.delta"; text: string }
  | { type: "chat.tool"; name: string; summary: string }
  // chat.compact：CC 上下文压缩进度（status/compact_boundary 帧归并转发；CLI 不输出进度百分比，完成行的压缩率由 1-post/pre 实算）
  | { type: "chat.compact"; phase: "start" }
  | { type: "chat.compact"; phase: "done"; result: "success" | "failed"; error?: string; preTokens?: number; postTokens?: number; durationMs?: number }
  // chat.done 可选字段：model/effort = SDK init 上报的实际生效值；compacted = 本轮发生过 compact（扩展据此下一轮强制附带页面）
  | { type: "chat.done"; sessionId: string; model?: string; effort?: EffortLevelSetting | null; fast?: FastModeRuntime; compacted?: boolean }
  // settings.state：请求设置的全量镜像 + 可选 CC 运行时真值；广播给全部视图，快照时定向补发
  | {
      type: "settings.state";
      permissionMode: PermissionModeSetting;
      model?: string;
      effort?: EffortLevelSetting;
      fastMode: boolean;
      /** fast-only 已改请求但尚无新 CC fast 真值；缺省/ false 不得清缓存 */
      fastPending?: boolean;
      runtime?: ExecutionRuntime;
    }
  // settings.error：原生设置应用失败，不属于聊天轮次终结，不得据它清除 busy
  | { type: "settings.error"; message: string }
  | { type: "chat.error"; message: string }
  // chat.aborted：本轮被用户手动停止（桥接立即下发，不等 CLI 收尾帧；客户端据它解除 busy 并保留已生成的部分文字）
  | { type: "chat.aborted" }
  // chat.user：用户消息回显（广播给全部视图，含发送方——视图不再本地乐观上屏，气泡一致性由桥接保证）
  // display=气泡正文（用户原始输入）；sent=实际发送全文（右键溯源）；note=附带结果说明（渲染为 tool 泡）
  | { type: "chat.user"; display: string; sent: string; note?: string }
  // chat.sync：工作区快照（client.ready 后推送）——新视图/重连视图据它补齐在途轮次、挂起审批与草稿
  | {
      type: "chat.sync";
      busy: boolean;
      /** 本轮已流出的部分文本（busy 时作 streaming 续播；非 busy 时为空） */
      streamText: string;
      /** 在途轮的用户气泡（未落盘，历史回放里没有，靠它补齐） */
      user: { display: string; sent: string } | null;
      permReq: { requestId: string; tool: string; detail: string } | null;
      /** 工作区当前草稿（视图输入框镜像） */
      draft: string;
      /** 工作区正在压缩上下文（视图接入即提示；秒数从接入时刻近似起算） */
      compacting: boolean;
    }
  // chat.draft：草稿镜像广播（不回显上报方，避免光标被回包顶跳）
  | { type: "chat.draft"; text: string }
  | { type: "permission.request"; requestId: string; tool: string; detail: string }
  // permission.resolved：任一视图已裁决，其它视图撤掉卡片（广播）
  | { type: "permission.resolved"; requestId: string }
  // folder.opened：folder.open 的定向应答；script=已刷新续聊脚本文件名（无别名时为 null）
  | { type: "folder.opened"; path: string; script: string | null }
  | { type: "session.history.data"; messages: HistoryMessage[] }
  | { type: "session.list.data"; sessions: SessionInfo[]; currentId: string | null }
  | { type: "alias.list.data"; aliases: AliasInfo[]; currentId: string | null };

/** 页面信息丰富度档位：brief 精简 / standard 标准 / rich 丰富（对应附带网页时注入正文的最大字符数，档位上限见扩展 attach-policy） */
export type PageRichness = "brief" | "standard" | "rich";

/**
 * 校验页面信息丰富度档位字符串。
 * @param v 任意值
 * @returns 是否为合法 PageRichness
 */
export function isPageRichness(v: unknown): v is PageRichness {
  return v === "brief" || v === "standard" || v === "rich";
}

/**
 * 校验权限模式字符串。
 * @param v 任意值
 * @returns 是否为合法 PermissionModeSetting
 */
export function isPermissionMode(v: unknown): v is PermissionModeSetting {
  return v === "auto" || v === "acceptEdits" || v === "plan" || v === "approve-each";
}

/**
 * 校验 effort 档位字符串。
 * @param v 任意值
 * @returns 是否为合法 EffortLevelSetting
 */
export function isEffortLevel(v: unknown): v is EffortLevelSetting {
  return v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max";
}

/**
 * 校验 CC 回报的 fast 状态。
 * @param v 任意外部值
 * @returns 是否为原生 FastModeState
 */
export function isFastModeState(v: unknown): v is FastModeState {
  return v === "off" || v === "cooldown" || v === "on";
}

/**
 * 校验 CC 回报的 fast 禁用原因。
 * @param v 任意外部值
 * @returns 是否为原生 FastModeDisabledReason
 */
export function isFastModeDisabledReason(v: unknown): v is FastModeDisabledReason {
  return v === "free" || v === "preference" || v === "extra_usage_disabled" || v === "network_error"
    || v === "unknown" || v === "not_first_party" || v === "disabled_by_env" || v === "model_not_allowed"
    || v === "sdk_opt_in_required" || v === "pending";
}

/**
 * 解析客户端消息。WS 帧不可信，任何非法输入返回 null，绝不抛异常。
 * @param raw 原始帧文本
 * @returns 合法消息或 null
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw);
    if (typeof m !== "object" || m === null) return null;
    switch (m.type) {
      case "auth":
        return typeof m.token === "string" ? m : null;
      case "client.ready":
      case "chat.abort":
      case "session.history":
      case "session.list":
      case "session.new":
      case "alias.list":
      case "folder.pick":
      case "folder.open":
        return m;
      case "chat.draft":
        // 草稿逐键上报：上限 10 万字符防异常客户端刷屏（正常草稿远低于此）
        return typeof m.text === "string" && m.text.length <= 100_000 ? m : null;
      case "folder.bind":
        return typeof m.path === "string" && m.path.length > 0 ? m : null;
      case "chat.send": {
        if (typeof m.text !== "string" || m.text.length === 0) return null;
        // display/note 为可选镜像字段：只接受字符串（display 允许空串=纯文件发送；note 空串剥掉）
        const display = typeof m.display === "string" ? m.display : undefined;
        const note = typeof m.note === "string" && m.note.length > 0 ? m.note : undefined;
        if (m.uploads === undefined) return { type: "chat.send", text: m.text, ...(display !== undefined ? { display } : {}), ...(note ? { note } : {}) };
        // uploads 全量严格校验：数量/名单/单文件/总量任一越界整帧拒绝（扩展侧已先做友好拦截，这里是防线）
        if (!Array.isArray(m.uploads) || m.uploads.length === 0 || m.uploads.length > MAX_UPLOAD_FILES) return null;
        let total = 0;
        const uploads: UploadFile[] = [];
        for (const u of m.uploads) {
          if (typeof u !== "object" || u === null) return null;
          if (typeof u.name !== "string" || u.name.length === 0 || u.name.length > 255) return null;
          if (typeof u.dataB64 !== "string" || u.dataB64.length === 0 || u.dataB64.length > MAX_UPLOAD_B64_CHARS) return null;
          total += u.dataB64.length;
          if (total > MAX_UPLOAD_TOTAL_B64) return null;
          uploads.push({ name: u.name, dataB64: u.dataB64 });
        }
        return { type: "chat.send", text: m.text, ...(display !== undefined ? { display } : {}), ...(note ? { note } : {}), uploads };
      }
      case "permission.response":
        return typeof m.requestId === "string" && typeof m.allow === "boolean" ? m : null;
      case "session.switch":
      case "session.delete":
        return typeof m.sessionId === "string" && m.sessionId.length > 0 ? m : null;
      case "alias.create": {
        if (typeof m.name !== "string" || m.name.trim().length === 0
          || typeof m.folder !== "string" || m.folder.length === 0
          || (typeof m.sessionId !== "string" && m.sessionId !== null)) return null;
        // pageRichness 为可选字段：只接受合法档位，非法值剥掉（与 settings.set 的 model/effort 同一策略）
        const out: Extract<ClientMessage, { type: "alias.create" }> = { type: "alias.create", name: m.name, folder: m.folder, sessionId: m.sessionId };
        if (isPageRichness(m.pageRichness)) out.pageRichness = m.pageRichness;
        return out;
      }
      case "alias.update": {
        if (typeof m.id !== "string" || m.id.length === 0) return null;
        // 逐字段校验组装：可选字段只带合法值；sessionId 出现时必须显式是 string 或 null（允许改成"新会话"）
        const out: Extract<ClientMessage, { type: "alias.update" }> = { type: "alias.update", id: m.id };
        if (typeof m.name === "string" && m.name.trim().length > 0) out.name = m.name;
        if (typeof m.folder === "string" && m.folder.length > 0) out.folder = m.folder;
        if (isPageRichness(m.pageRichness)) out.pageRichness = m.pageRichness;
        if ("sessionId" in m) {
          if (typeof m.sessionId !== "string" && m.sessionId !== null) return null;
          out.sessionId = m.sessionId;
        }
        return out;
      }
      case "alias.delete":
      case "alias.select":
        return typeof m.id === "string" && m.id.length > 0 ? m : null;
      case "settings.set": {
        if (!isPermissionMode(m.permissionMode)) return null;
        // model/effort 为可选字段：只接受合法值，空串视为"跟随默认"（不下发）
        const model = typeof m.model === "string" && m.model.length > 0 ? m.model : undefined;
        const effort = isEffortLevel(m.effort) ? m.effort : undefined;
        // 缺省与非法值都为 undefined：由 Workspace 保留旧偏好，兼容尚未支持 fast 的客户端
        const fastMode = typeof m.fastMode === "boolean" ? m.fastMode : undefined;
        const fastOnly = typeof m.fastOnly === "boolean" ? m.fastOnly : undefined;
        const hello = m.hello === true ? true : undefined;
        // fields 只描述用户本次明确修改的字段；非法项剥掉并去重，空数组保留为 no-op
        const fields = Array.isArray(m.fields)
          ? [...new Set<ExecutionSettingField>(m.fields.filter((v: unknown): v is ExecutionSettingField =>
            v === "permissionMode" || v === "model" || v === "effort" || v === "fastMode"))]
          : undefined;
        return { type: "settings.set", permissionMode: m.permissionMode, model, effort, fastMode, fastOnly, hello, fields };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * 序列化服务消息为帧文本。
 * @param msg 服务消息
 * @returns JSON 字符串
 */
export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
