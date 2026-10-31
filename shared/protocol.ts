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

/** Claude Code 实际回报的原生权限模式；与用户可请求的四档设置分开保存 */
export type ActualPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/** CC init/result 最近确认的执行真值；缺字段表示没有新证据，不等于 off */
export interface ExecutionRuntime {
  model?: string;
  effort?: EffortLevelSetting | null;
  fast?: FastModeRuntime;
  /** system/init 与 system/status 最近上报的原生权限模式 */
  permissionMode?: ActualPermissionMode;
}

/** MCP 表单支持的字段值；数组仅用于协议应答兼容，当前表单 schema 不开放数组字段。 */
export type ElicitationValue = string | number | boolean | string[];

/** MCP form 的已校验字段子集；title/description 只用于展示，name 是应答键。 */
export interface ElicitationFormField {
  name: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  default?: string | number | boolean;
  enum?: string[];
}

/** MCP elicitation 的挂起请求；url 仅用于当次打开，结算记录必须先去敏。 */
export interface ElicitationRequestInfo {
  serverName: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  elicitationId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  fields?: ElicitationFormField[];
}

/** MCP 用户裁决；accept 的 form 可携带 content，url 不携带。 */
export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, ElicitationValue>;
}

/** 本机 CLI 2.1.301 已验证的 UserDialog 请求与结果；未知 kind 不声明支持。 */
export type UserDialogRequestInfo =
  | {
      dialogKind: "refusal_fallback_prompt";
      originalModel: string;
      fallbackModel: string;
      apiRefusalCategory?: string;
      guidanceText?: string;
      retractedMessageUuids?: string[];
    }
  | {
      dialogKind: "auto_mode_server_fallback";
      gatewayHost?: string;
      title: string;
      paragraphs: string[];
      helpUrl: string;
    };

export type UserDialogAction = "retry_fallback" | "edit_prompt" | "continue" | "interrupt" | "cancelled";
export interface UserDialogResponse {
  action: UserDialogAction;
}

/** 统一交互请求；kind 决定卡片文案，结构化字段只承载对应 UI 需要的内容 */
export interface InteractionRequest {
  requestId: string;
  kind: "ask" | "permission" | "exit_plan" | "elicitation" | "user_dialog";
  tool?: string;
  toolUseId?: string;
  /** 中文可读摘要；长参数、计划等技术详情放 detail/plan，不在摘要中截断后冒充全文 */
  summary?: string;
  detail?: string;
  questions?: AskQuestion[];
  plan?: string;
  planFilePath?: string;
  elicitation?: ElicitationRequestInfo;
  userDialog?: UserDialogRequestInfo;
  createdAt?: number;
}

export type InteractionOutcome = "answered" | "allowed" | "denied" | "cancelled" | "timeout" | "error";

/** 已解决交互的只读记录；同一记录用于实时广播、在途快照与历史回放 */
export interface InteractionRecord extends InteractionRequest {
  outcome: InteractionOutcome;
  resolvedAt: number;
  answers?: Record<string, string>;
  feedback?: string;
  /** MCP 实际裁决和已提交字段名；content 值本身不进入记录/侧车 */
  elicitationAction?: ElicitationResponse["action"];
  submittedFields?: string[];
  /** URL 流程收到 CC elicitation_complete 后更新为 true */
  elicitationComplete?: boolean;
  /** CLI 自有对话框的实际选择；与 outcome 分开保留，不能笼统记为“已允许” */
  userDialogAction?: UserDialogAction;
  decider?: "user" | "timeout" | "abort" | "close" | "system";
}

/** 工具执行状态；unknown 仅用于历史中存在调用但没有可配对结果的旧记录 */
export type ToolExecutionStatus = "running" | "success" | "error" | "unknown";

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
  /** Ask、权限或计划等交互的只读结果；有记录时不显示原始工具 JSON */
  interaction?: InteractionRecord;
  /** 稳定关联工具调用与结果 */
  toolUseId?: string;
  /** 工具执行状态与完整技术详情；摘要 text 不能代替这些字段 */
  toolStatus?: ToolExecutionStatus;
  toolInput?: string;
  toolOutput?: string;
  /** 状态记录的完整技术详情（错误列表、用量等）；默认折叠，text 仍是中文摘要 */
  detail?: string;
  /** 分页历史可带稳定 ID/时间；旧桥消息允许缺省，新视图收到后据此 upsert */
  id?: string;
  createdAt?: number;
}

/** 在途时间线项：与历史消息同形，另带稳定 ID 和创建时间供重连 upsert。 */
export interface TimelineItem extends HistoryMessage {
  id: string;
  createdAt: number;
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

/** CC AskUserQuestion 的单个问题（与工具 input.questions 元素同形） */
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect: boolean;
}

/** 挂起的提问请求（chat.ask 广播与 chat.sync 快照共用） */
export interface AskRequest {
  requestId: string;
  questions: AskQuestion[];
}

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
  | { type: "permission.response"; requestId: string; allow: boolean; feedback?: string }
  // chat.ask.answer：用户对 AskUserQuestion 卡片的作答（answers 键=问题文本，值=所选标签或 Other 自由文本；多选用 ", " 连接）
  | { type: "chat.ask.answer"; requestId: string; answers: Record<string, string> }
  // chat.interaction.respond：MCP form/url 或 CLI UserDialog；敏感 content 只用于本次 SDK 应答
  | { type: "chat.interaction.respond"; requestId: string; response: ElicitationResponse | UserDialogResponse }
  | { type: "session.history"; before?: string; limit?: number }
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
  | { type: "chat.tool"; name: string; summary: string; toolUseId?: string; status?: ToolExecutionStatus; input?: string; output?: string }
  // chat.timeline：压缩、实际模式、通知等只读状态记录；稳定 id 与 chat.sync.timeline 对齐，重连只更新不重复
  | { type: "chat.timeline"; item: TimelineItem }
  // chat.compact：CC 上下文压缩进度（status/compact_boundary 帧归并转发；CLI 不输出进度百分比，完成行的压缩率由 1-post/pre 实算）
  | { type: "chat.compact"; phase: "start" }
  | { type: "chat.compact"; phase: "done"; result: "success" | "failed"; error?: string; preTokens?: number; postTokens?: number; durationMs?: number; recorded?: boolean }
  // chat.requesting：CC 正在等待 API 响应的瞬时状态；不进入永久时间线，终结/断线时清除
  | { type: "chat.requesting"; requesting: boolean }
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
  | { type: "chat.error"; message: string; recorded?: boolean }
  // chat.aborted：本轮被用户手动停止（桥接立即下发，不等 CLI 收尾帧；客户端据它解除 busy 并保留已生成的部分文字）
  // recorded=true 表示错误/停止记录已通过 chat.timeline 上屏，客户端只终结轮次、不重复追加
  | { type: "chat.aborted"; recorded?: boolean }
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
      /** 挂起的提问（快照补卡片；任一视图作答后全视图撤下） */
      askReq: AskRequest | null;
      /** 工作区当前草稿（视图输入框镜像） */
      draft: string;
      /** 工作区正在压缩上下文（视图接入即提示；秒数从接入时刻近似起算） */
      compacting: boolean;
      /** CC 正在等待 API 响应；旧桥缺省视为 false */
      requesting?: boolean;
      /** 全部并发挂起交互；旧 permReq/askReq 仅为兼容旧客户端保留 */
      pendingInteractions?: InteractionRequest[];
      /** 本轮已解决交互，供重连/新视图补齐尚未落盘的只读记录 */
      interactions?: InteractionRecord[];
      /** 本轮完整在途顺序；存在时优先于旧 user+streamText 单段快照 */
      timeline?: TimelineItem[];
    }
  // chat.draft：草稿镜像广播（不回显上报方，避免光标被回包顶跳）
  | { type: "chat.draft"; text: string }
  | {
      type: "permission.request";
      requestId: string;
      tool: string;
      detail: string;
      kind?: "permission" | "exit_plan";
      toolUseId?: string;
      summary?: string;
      plan?: string;
      planFilePath?: string;
    }
  // permission.resolved：携带完整只读记录；缺 record 的旧桥仅撤卡
  | { type: "permission.resolved"; requestId: string; record?: InteractionRecord }
  // chat.ask：CC 发起 AskUserQuestion（auto 等模式同样可达 canUseTool，本机假上游探针实证）；任一视图作答后广播结果
  | { type: "chat.ask"; requestId: string; questions: AskQuestion[] }
  | { type: "chat.ask.resolved"; requestId: string; record?: InteractionRecord }
  // 独立交互的通用帧；不再把 MCP/UserDialog 错标成普通权限审批
  | { type: "chat.interaction"; request: InteractionRequest }
  | { type: "chat.interaction.resolved"; requestId: string; record: InteractionRecord }
  // folder.opened：folder.open 的定向应答；script=已刷新续聊脚本文件名（无别名时为 null）
  | { type: "folder.opened"; path: string; script: string | null }
  | {
      type: "session.history.data";
      messages: HistoryMessage[];
      /** 分页应答回显请求游标；缺省表示最新历史快照，应替换而非前插 */
      before?: string;
      hasMore?: boolean;
      nextCursor?: string;
    }
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
 * 校验 MCP 表单应答是否仍符合请求字段；UI 与桥接共用，未知键和非法类型均拒绝。
 * @param fields 桥接已解析的表单字段
 * @param content 客户端提交的字段值
 * @returns 中文错误列表；空数组表示可提交给 SDK
 */
export function validateElicitationContent(
  fields: ElicitationFormField[],
  content: Record<string, ElicitationValue>,
): string[] {
  const errors: string[] = [];
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const key of Object.keys(content)) {
    if (!byName.has(key)) errors.push(`${key}：不是请求中的字段`);
  }
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) errors.push(`${field.title}：必填`);
      continue;
    }
    if (field.type === "string") {
      if (typeof value !== "string" || (field.required && !value.trim())) errors.push(`${field.title}：需要非空文本`);
      else if (field.enum && !field.enum.includes(value as string)) errors.push(`${field.title}：不在可选值中`);
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") errors.push(`${field.title}：需要布尔值`);
    } else if (typeof value !== "number" || !Number.isFinite(value)
      || (field.type === "integer" && !Number.isInteger(value))) {
      errors.push(`${field.title}：需要${field.type === "integer" ? "整数" : "数字"}`);
    }
  }
  return errors;
}

/**
 * 去掉 MCP URL 中的凭据、查询和片段，仅供只读记录；真实打开仍使用挂起请求中的完整地址。
 * @param raw 未信任的 URL
 * @returns http/https 的去敏地址；其它协议或非法地址返回 null
 */
export function sanitizeElicitationUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
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
      case "session.list":
      case "session.new":
      case "alias.list":
      case "folder.pick":
      case "folder.open":
        return m;
      case "session.history": {
        if (m.before !== undefined && (typeof m.before !== "string" || m.before.length === 0 || m.before.length > 1000)) return null;
        if (m.limit !== undefined && (!Number.isInteger(m.limit) || m.limit < 1 || m.limit > 200)) return null;
        return {
          type: "session.history",
          ...(typeof m.before === "string" ? { before: m.before } : {}),
          ...(typeof m.limit === "number" ? { limit: m.limit } : {}),
        };
      }
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
      case "permission.response": {
        if (typeof m.requestId !== "string" || m.requestId.length === 0 || typeof m.allow !== "boolean") return null;
        if (m.feedback !== undefined && (typeof m.feedback !== "string" || m.feedback.length > 100_000)) return null;
        return {
          type: "permission.response", requestId: m.requestId, allow: m.allow,
          ...(typeof m.feedback === "string" ? { feedback: m.feedback } : {}),
        };
      }
      case "chat.ask.answer": {
        if (typeof m.requestId !== "string" || m.requestId.length === 0) return null;
        const a = m.answers;
        if (!a || typeof a !== "object" || Array.isArray(a)) return null;
        const entries = Object.entries(a as Record<string, unknown>);
        if (entries.length > 16) return null; // CC 一次提问的问题数有限，防御异常大对象
        const answers: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (typeof v !== "string" || v.length > 4000 || k.length > 4000) return null;
          answers[k] = v;
        }
        return { type: "chat.ask.answer", requestId: m.requestId, answers };
      }
      case "chat.interaction.respond": {
        if (typeof m.requestId !== "string" || m.requestId.length === 0 || m.requestId.length > 1000
          || !m.response || typeof m.response !== "object" || Array.isArray(m.response)) return null;
        const action = m.response.action;
        const isElicitationAction = action === "accept" || action === "decline" || action === "cancel";
        const isUserDialogAction = action === "retry_fallback" || action === "edit_prompt"
          || action === "continue" || action === "interrupt" || action === "cancelled";
        if (!isElicitationAction && !isUserDialogAction) return null;
        // UserDialog 只有枚举结果；夹带 content 说明客户端与请求类型不匹配，直接拒绝。
        if (isUserDialogAction && m.response.content !== undefined) return null;
        let content: Record<string, ElicitationValue> | undefined;
        if (m.response.content !== undefined) {
          const raw = m.response.content;
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
          const entries = Object.entries(raw as Record<string, unknown>);
          if (entries.length > 64) return null;
          content = {};
          for (const [key, value] of entries) {
            if (!key || key.length > 4000) return null;
            if (typeof value === "string" && value.length <= 100_000) content[key] = value;
            else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) content[key] = value;
            else if (Array.isArray(value) && value.length <= 256
              && value.every((item) => typeof item === "string" && item.length <= 100_000)) content[key] = value;
            else return null;
          }
        }
        return {
          type: "chat.interaction.respond", requestId: m.requestId,
          response: { action, ...(content !== undefined ? { content } : {}) },
        };
      }
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
