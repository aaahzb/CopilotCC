import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 读取真实生产入口，供依赖装配契约检查。
 * 服务单测会自行注入完整依赖，只有检查入口才能发现托盘漏接持久化。
 * @param entry 入口文件名
 * @returns UTF-8 源码
 */
function entrySource(entry: string): string {
  return fs.readFileSync(fileURLToPath(new URL(`../src/${entry}`, import.meta.url)), "utf-8");
}

describe("生产入口依赖装配", () => {
  it.each(["index.ts", "tray.ts"])("%s 注入同一配置目录的 workspace.json", (entry) => {
    const source = entrySource(entry);
    // 允许换行与注释夹在语句之间，但构造器、配置目录和文件名必须保持生产契约。
    const workspaceStore = /workspaceStore\s*:\s*new\s+WorkspaceStore\s*\(\s*path\.join\s*\(\s*configDir\s*\(\s*\)\s*,\s*["']workspace\.json["']\s*,?\s*\)\s*,?\s*\)/;
    expect(source).toMatch(workspaceStore);
  });
});
