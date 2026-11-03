import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { openInFileManager } from "../src/folder-picker";

describe("openInFileManager", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it.skipIf(process.platform !== "win32")("Windows 启动 Explorer 时不得隐藏 GUI 窗口", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawnMock.mockReturnValue(child);

    const pending = openInFileManager("D:\\notes");
    child.emit("spawn");

    await expect(pending).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledWith("explorer.exe", ["D:\\notes"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
