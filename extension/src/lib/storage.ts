import type { PermissionModeSetting, EffortLevelSetting } from "./protocol";

/** 扩展设置（chrome.storage.local 键 ccc.settings） */
export interface ExtSettings {
  token: string;
  port: number;
  folderHistory: string[];
  attachEnabled: boolean;
  permissionMode: PermissionModeSetting;
  /** 模型别名或完整 ID；空串 = 跟随 CLI 配置 */
  model: string;
  /** 推理强度；空串 = 默认 */
  effort: EffortLevelSetting | "";
  lastFolder: string;
}

export const DEFAULTS: ExtSettings = {
  token: "",
  port: 19280,
  folderHistory: [],
  attachEnabled: true,
  permissionMode: "auto",
  model: "",
  effort: "",
  lastFolder: "",
};

const KEY = "ccc.settings";
const QUOTE_KEY = "ccc.pendingQuote";

/**
 * 读取设置，缺省字段回填默认值。
 * @returns 完整设置
 */
export async function loadSettings(): Promise<ExtSettings> {
  const raw = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...((raw[KEY] ?? {}) as Partial<ExtSettings>) };
}

/**
 * 合并写入设置补丁。
 * @param patch 要更新的字段
 */
export async function saveSettings(patch: Partial<ExtSettings>): Promise<void> {
  const cur = await loadSettings();
  await chrome.storage.local.set({ [KEY]: { ...cur, ...patch } });
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
