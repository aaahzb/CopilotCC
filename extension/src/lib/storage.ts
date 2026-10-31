import type { PermissionModeSetting, EffortLevelSetting, FastModeRuntime, ActualPermissionMode } from "./protocol";

/** 扩展设置（chrome.storage.local 键 ccc.settings） */
export interface ExtSettings {
  token: string;
  port: number;
  /** 桥接地址；默认本机回环。配对串里携带，界面不暴露编辑 */
  host: string;
  folderHistory: string[];
  attachEnabled: boolean;
  permissionMode: PermissionModeSetting;
  /** 模型别名或完整 ID；空串 = 跟随 CLI 配置 */
  model: string;
  /** 推理强度；空串 = 默认 */
  effort: EffortLevelSetting | "";
  /** 用户请求的 Claude Code 原生 fast 设置；实际状态另存 RuntimeCache.fast */
  fastMode: boolean;
  lastFolder: string;
}

export const DEFAULTS: ExtSettings = {
  token: "",
  port: 19280,
  host: "127.0.0.1",
  folderHistory: [],
  attachEnabled: true,
  permissionMode: "auto",
  model: "",
  effort: "",
  fastMode: false,
  lastFolder: "",
};

const KEY = "ccc.settings";
const QUOTE_KEY = "ccc.pendingQuote";
let settingsWriteChain: Promise<void> = Promise.resolve(); // 无 Web Locks 时使用单视图队列；现代环境使用同源跨上下文锁

/**
 * 读取设置，缺省字段回填默认值。
 * @returns 完整设置
 */
export async function loadSettings(): Promise<ExtSettings> {
  const raw = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...((raw[KEY] ?? {}) as Partial<ExtSettings>) };
}

/**
 * 串行合并写入设置补丁，并返回本次写入的完整快照。
 * @param patch 要更新的字段
 * @returns 本次补丁合并后的完整设置；后续镜像写入不会改变该返回值
 */
export function saveSettings(patch: Partial<ExtSettings>): Promise<ExtSettings> {
  const write = async (): Promise<ExtSettings> => {
    const cur = await loadSettings();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  };
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request("ccc.settings.write", write); // 调用时即跨侧边栏/弹窗排队
  const operation = settingsWriteChain.then(write);
  settingsWriteChain = operation.then(() => undefined, () => undefined);
  return operation;
}

/**
 * 把文件夹推到历史列表最前（去重，最多 10 条），并记为 lastFolder。
 * @param p 文件夹路径
 */
export async function pushFolderHistory(p: string): Promise<void> {
  const s = await loadSettings();
  const list = [p, ...s.folderHistory.filter((x) => x !== p)].slice(0, 10);
  await saveSettings({ folderHistory: list, lastFolder: p });
}

/**
 * 取出右键菜单暂存的选中文字（取一次即清空）。
 * @returns 选中文字或 null
 */
export async function takePendingQuote(): Promise<string | null> {
  const r = await chrome.storage.session.get(QUOTE_KEY);
  const v = r[QUOTE_KEY];
  if (typeof v === "string") {
    await chrome.storage.session.remove(QUOTE_KEY);
    return v;
  }
  return null;
}

/** 桥接上报的实际生效模型/effort/fast（chrome.storage.local 键 ccc.runtime）：跨重载缓存，换桥时清空 */
export interface RuntimeCache {
  /** 实际生效的模型 ID（原始值，如 claude-fable-5-1） */
  model?: string;
  /** 实际生效的 effort；null = 该会话不下发 effort 参数 */
  effort?: EffortLevelSetting | null;
  /** CC 原生 fast 实际状态与禁用原因；undefined = 等待/没有回报 */
  fast?: FastModeRuntime;
  /** system/init/status 最近回报的原生权限模式；与请求下拉分开 */
  permissionMode?: ActualPermissionMode;
}

const RUNTIME_KEY = "ccc.runtime";

/**
 * 读取运行时信息缓存。
 * @returns 上次桥接上报的实际生效模型/effort/fast；无缓存为空对象
 */
export async function loadRuntimeCache(): Promise<RuntimeCache> {
  const raw = await chrome.storage.local.get(RUNTIME_KEY);
  return (raw[RUNTIME_KEY] ?? {}) as RuntimeCache;
}

/**
 * 写入运行时信息缓存（整体覆盖）。
 * @param rt 本次 chat.done 上报的实际生效值
 */
export async function saveRuntimeCache(rt: RuntimeCache): Promise<void> {
  await chrome.storage.local.set({ [RUNTIME_KEY]: rt });
}

/** 清空运行时信息缓存（换桥时调用：新桥的实际生效值未知，不能沿用旧桥的） */
export async function clearRuntimeCache(): Promise<void> {
  await chrome.storage.local.remove(RUNTIME_KEY);
}
