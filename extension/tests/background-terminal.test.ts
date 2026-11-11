import { afterEach, describe, expect, it, vi } from "vitest";

type MessageListener = (
  message: { type: string; aliasId?: string | null },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("background 独立终端入口", () => {
  it("terminal.open-window 不被 ccc.* 前缀过滤吞掉，并真实请求创建窗口", async () => {
    let onMessage: MessageListener | null = null;
    const create = vi.fn(async (options: { url: string }) => ({
      id: 91, tabs: [{ url: options.url }],
    }));
    vi.stubGlobal("defineBackground", (main: () => void) => main());
    vi.stubGlobal("chrome", {
      sidePanel: { setPanelBehavior: vi.fn(async () => undefined), open: vi.fn() },
      contextMenus: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: (listener: MessageListener) => { onMessage = listener; } },
      },
      windows: {
        getAll: vi.fn(async () => []), create,
        update: vi.fn(async () => ({})),
        onRemoved: { addListener: vi.fn() },
      },
      tabs: { onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn(async () => []) },
      storage: { session: { set: vi.fn(async () => undefined) } },
    });
    await import("../src/entrypoints/background");
    expect(onMessage).not.toBeNull();
    const response = new Promise<unknown>((resolve) => {
      const keepAlive = onMessage!({ type: "terminal.open-window", aliasId: "alias-a" }, {}, resolve);
      expect(keepAlive).toBe(true);
    });
    await expect(response).resolves.toMatchObject({ ok: true, winId: 91, reused: false });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      type: "popup", url: "chrome-extension://test/terminal.html?alias=alias-a",
    }));
  });
});
