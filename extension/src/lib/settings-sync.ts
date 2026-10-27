import type { ClientMessage, ServerMessage } from "./protocol";
import type { ExtSettings, RuntimeCache } from "./storage";

type SettingsSet = Extract<ClientMessage, { type: "settings.set" }>;
type SettingsState = Extract<ServerMessage, { type: "settings.state" }>;
export type ExecutionSettingsPatch = Partial<Pick<ExtSettings, "permissionMode" | "model" | "effort" | "fastMode">>;

type ChatDone = Extract<ServerMessage, { type: "chat.done" }>;

/**
 * 把本地完整执行设置转成桥接消息；fast 始终显式携带，供启动 hello 与手动修改共用。
 * @param settings 当前完整扩展设置
 * @param hello true 表示自动连接播种；手动用户修改必须为 false
 * @param fields 手动修改的字段掩码；hello 与不兼容旧桥的全量消息省略
 * @returns 完整 settings.set 消息，fields 存在时只有列出的字段是变更意图
 */
export function toSettingsSet(settings: ExtSettings, hello = false, fields?: import("./protocol").ExecutionSettingField[]): SettingsSet {
  return {
    type: "settings.set",
    permissionMode: settings.permissionMode,
    model: settings.model || undefined,
    effort: settings.effort || undefined,
    fastMode: settings.fastMode,
    ...(hello ? { hello: true } : {}),
    ...(!hello && fields !== undefined ? { fields } : {}),
  };
}

/**
 * 构造仅改 fast 的设置消息；完整字段保留给旧桥，fastOnly 让新桥忽略视图中的旧执行字段。
 * @param settings 当前完整扩展设置
 * @returns 带 fastOnly 意图的完整 settings.set
 */
export function toFastSettingsSet(settings: ExtSettings): SettingsSet {
  return { ...toSettingsSet(settings), fastOnly: true };
}

/**
 * 镜像桥接已接受的执行设置，不触碰 token、连接参数、文件夹历史等本地字段。
 * @param current 当前完整扩展设置
 * @param message 桥接 settings.state 消息
 * @returns 新的完整扩展设置；调用方只更新本地，不回发以免循环
 */
export function mirrorExecutionSettings(current: ExtSettings, message: SettingsState): ExtSettings {
  return {
    ...current,
    permissionMode: message.permissionMode,
    model: message.model ?? "",
    effort: message.effort ?? "",
    fastMode: message.fastMode,
  };
}

/**
 * 判断 settings.state 是否改变请求设置；仅 runtime 更新不应清除既有设置错误。
 * @param current 当前完整扩展设置
 * @param message 桥接 settings.state 消息
 * @returns 权限、模型、effort 或 fast 请求值是否变化
 */
export function hasExecutionSettingsChange(current: ExtSettings, message: SettingsState): boolean {
  const next = mirrorExecutionSettings(current, message);
  return current.permissionMode !== next.permissionMode || current.model !== next.model
    || current.effort !== next.effort || current.fastMode !== next.fastMode;
}

/**
 * 合并 chat.done 的运行时字段，兼容只携带部分字段的旧桥；缺字段保留最近真值。
 * @param current 最近缓存的 CC 实际运行时状态
 * @param message 本轮 chat.done 消息
 * @returns 合并后的新缓存；effort=null 明确表示实际未下发 effort
 */
export function mergeDoneRuntime(current: RuntimeCache, message: ChatDone): RuntimeCache {
  const next: RuntimeCache = { ...current };
  if (typeof message.model === "string" && message.model.length > 0) next.model = message.model;
  if (message.effort !== undefined) next.effort = message.effort;
  if (message.fast) next.fast = message.fast;
  return next;
}

/**
 * 应用 settings.state 的可选完整运行时快照；缺省保留，显式空对象或部分对象整体替换。
 * @param current 最近缓存的 CC 实际运行时状态
 * @param message 桥接 settings.state 消息
 * @returns 保留的当前缓存、完整快照，或仅删除 fast 的缓存
 */
export function runtimeFromSettingsState(current: RuntimeCache, message: SettingsState): RuntimeCache {
  if (message.runtime !== undefined) return { ...message.runtime };
  if (message.fastPending !== true || current.fast === undefined) return current;
  const next = { ...current };
  delete next.fast; // model/effort 缓存仍有效，只让 fast 等待下一次 CC 真值
  return next;
}
