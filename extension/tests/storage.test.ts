import { describe, it, expect, beforeEach } from "vitest";
import { loadSettings, saveSettings, pushFolderHistory, takePendingQuote, DEFAULTS } from "../src/lib/storage";

/** chrome.storage 内存桩 */
function memArea() {
  const data: Record<string, unknown> = {};
  return {
    get: async (k: string) => ({ [k]: data[k] }),
    set: async (o: Record<string, unknown>) => Object.assign(data, o),
    remove: async (k: string) => { delete data[k]; },
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = { storage: { local: memArea(), session: memArea() } };
});

describe("storage", () => {
  it("无存储时返回默认值", async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULTS);
    expect(s.port).toBe(19280);
    expect(s.permissionMode).toBe("auto");
  });

  it("saveSettings 合并补丁", async () => {
    await saveSettings({ token: "abc" });
    await saveSettings({ port: 20000 });
    const s = await loadSettings();
    expect(s.token).toBe("abc");
    expect(s.port).toBe(20000);
  });

  it("pushFolderHistory 去重、最新在前、最多 10 条", async () => {
    for (let i = 0; i < 12; i++) await pushFolderHistory(`D:\n${i}`);
    await pushFolderHistory("D:\n5");
    const s = await loadSettings();
    expect(s.folderHistory[0]).toBe("D:\n5");
    expect(s.folderHistory.filter((x) => x === "D:\n5").length).toBe(1);
    expect(s.folderHistory.length).toBe(10);
    expect(s.lastFolder).toBe("D:\n5");
  });

  it("takePendingQuote 取一次即清空", async () => {
    await chrome.storage.session.set({ "ccc.pendingQuote": "选中文字" });
    expect(await takePendingQuote()).toBe("选中文字");
    expect(await takePendingQuote()).toBeNull();
  });
});
