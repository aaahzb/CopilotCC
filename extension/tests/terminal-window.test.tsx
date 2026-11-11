import { describe, expect, it, vi } from "vitest";
import { PopupRegistry } from "../src/lib/popup-registry";
import { openTerminalWindow } from "../src/lib/terminal-window";

interface FakeWindow {
  id?: number;
  tabs?: Array<{ url?: string }>;
}

/** 创建仅含终端窗口所需 API 的 Chrome 替身。 */
function chromeFixture(initial: FakeWindow[] = []): {
  api: typeof chrome;
  windows: FakeWindow[];
  created: Array<Record<string, unknown>>;
  focused: number[];
} {
  const windows = [...initial];
  const created: Array<Record<string, unknown>> = [];
  const focused: number[] = [];
  let nextId = 100;
  const api = {
    runtime: { getURL: (name: string) => `chrome-extension://test/${name}` },
    windows: {
      getAll: vi.fn(async () => windows),
      create: vi.fn(async (options: Record<string, unknown>) => {
        created.push(options);
        const win = { id: ++nextId, tabs: [{ url: String(options.url) }] };
        windows.push(win);
        return win;
      }),
      update: vi.fn(async (id: number) => { focused.push(id); }),
    },
  } as unknown as typeof chrome;
  return { api, windows, created, focused };
}

describe("独立终端窗口去重", () => {
  it("同 alias 扫描并聚焦已有窗口，不重复创建；关闭后自愈", async () => {
    const f = chromeFixture();
    const registry = new PopupRegistry();
    const first = await openTerminalWindow("alias-a", registry, f.api);
    const second = await openTerminalWindow("alias-a", registry, f.api);
    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ ok: true, reused: true, winId: first.winId });
    expect(f.created).toHaveLength(1);
    expect(f.focused).toEqual([first.winId]);
    registry.windowRemoved(first.winId!);
    f.windows.splice(0); // Chrome 已真实移除窗口；后续扫描不得再把旧 URL 登记回来。
    const third = await openTerminalWindow("alias-a", registry, f.api);
    expect(third.reused).toBe(false);
    expect(f.created).toHaveLength(2);
  });

  it("service worker 内存丢失后从 terminal.html URL 重建注册表", async () => {
    const f = chromeFixture([{ id: 88, tabs: [{ url: "chrome-extension://test/terminal.html?alias=alias-a" }] }]);
    const result = await openTerminalWindow("alias-a", new PopupRegistry(), f.api);
    expect(result).toEqual({ ok: true, winId: 88, reused: true });
    expect(f.created).toHaveLength(0);
    expect(f.focused).toEqual([88]);
  });

  it("创建失败向上返回错误且不登记窗口，调用方因此不会发送 WS open", async () => {
    const f = chromeFixture();
    vi.mocked(f.api.windows.create).mockRejectedValueOnce(new Error("window failed"));
    const registry = new PopupRegistry();
    await expect(openTerminalWindow("alias-a", registry, f.api)).rejects.toThrow("window failed");
    expect(registry.terminalWindowFor("alias-a")).toBeNull();
  });
});
