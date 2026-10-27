import { describe, it, expect, beforeEach, vi } from "vitest";
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
    expect(s.fastMode).toBe(false);
  });

  it("旧存储缺 fast 时回填关闭，显式 false 可持久化", async () => {
    await chrome.storage.local.set({ "ccc.settings": { token: "old", fastMode: true } });
    expect((await loadSettings()).fastMode).toBe(true);
    await saveSettings({ fastMode: false });
    expect((await loadSettings()).fastMode).toBe(false);
    await chrome.storage.local.set({ "ccc.settings": { token: "older" } });
    expect((await loadSettings()).fastMode).toBe(false);
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

  it("并发设置补丁按调用顺序合并，不吞掉较快写入的 fast", async () => {
    await chrome.storage.local.set({ "ccc.settings": { ...DEFAULTS, fastMode: true } });
    const off = saveSettings({ fastMode: false });
    const mirroredModel = saveSettings({ model: "sonnet" });
    await Promise.all([off, mirroredModel]);
    const s = await loadSettings();
    expect(s.fastMode).toBe(false);
    expect(s.model).toBe("sonnet");
  });

  it("每次保存返回该次完整快照，调用方无需再次读取后被覆盖的值", async () => {
    const off = saveSettings({ fastMode: false });
    const laterMirror = saveSettings({ fastMode: true });
    const [offSnapshot] = await Promise.all([off, laterMirror]);
    expect(offSnapshot).toMatchObject({ fastMode: false });
    expect((await loadSettings()).fastMode).toBe(true);
  });


  it("两个独立视图在调用时进入同一 Web Locks 队列，旧镜像不会最后覆盖 fast=false", async () => {
    const data: Record<string, unknown> = { "ccc.settings": { ...DEFAULTS, fastMode: true } };
    let writes = 0;
    const local = {
      get: async (k: string) => ({ [k]: data[k] }),
      set: async (o: Record<string, unknown>) => {
        writes += 1;
        if (writes === 1) await new Promise((r) => setTimeout(r, 30));
        Object.assign(data, o);
      },
      remove: async (k: string) => { delete data[k]; },
    };
    const globals = globalThis as Record<string, unknown>;
    const previousChrome = globals.chrome;
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    globals.chrome = { storage: { local, session: memArea() } };
    let lockChain: Promise<void> = Promise.resolve();
    const locks = {
      request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
        const result = lockChain.then(callback);
        lockChain = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    let final: unknown;
    try {
      vi.resetModules();
      const viewA = await import("../src/lib/storage");
      vi.resetModules();
      const viewB = await import("../src/lib/storage");
      const firstA = viewA.saveSettings({ model: "fable" });
      const staleMirrorA = viewA.saveSettings({ fastMode: true });
      const userB = viewB.saveSettings({ fastMode: false });
      await Promise.all([firstA, staleMirrorA, userB]);
      final = await viewB.loadSettings();
    } finally {
      globals.chrome = previousChrome;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
      vi.resetModules();
    }
    expect(final).toMatchObject({ model: "fable", fastMode: false });
  });


});
