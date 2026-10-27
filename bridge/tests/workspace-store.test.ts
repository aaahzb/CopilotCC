import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceStore, type WorkspaceExecutionSettings } from "../src/workspace-store";

const FABLE = "claude-fable-5-1";
let dir: string;
let file: string;
let store: WorkspaceStore;

/** 构造合法执行设置，只覆盖当前用例关心的字段。 */
function execution(over: Partial<WorkspaceExecutionSettings> = {}): WorkspaceExecutionSettings {
  return { permissionMode: "auto", fastMode: true, ...over };
}

/** 直接写原始 JSON，模拟旧版或损坏磁盘形状。 */
function writeRaw(value: unknown): void {
  fs.writeFileSync(file, JSON.stringify({ folder: dir, aliasId: null, execution: value }, null, 2), "utf-8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-store-"));
  file = path.join(dir, "workspace.json");
  store = new WorkspaceStore(file);
});

describe("WorkspaceStore fast 恢复基线", () => {
  it("自动 request:null 与 actualModel 完整往返，缺省不与 null 混淆", () => {
    const expected = execution({ model: "opus", fastRestore: { request: null, actualModel: FABLE } });
    store.saveExecutionSettings(expected);
    expect(store.loadExecutionSettings()).toEqual(expected);
    store.saveExecutionSettings(execution({ model: "sonnet", fastRestore: { request: "sonnet" } }));
    expect(store.loadExecutionSettings()?.fastRestore).toEqual({ request: "sonnet" });
  });

  it("off 保存后从磁盘删除整个 restore", () => {
    store.saveExecutionSettings(execution({ model: "opus", fastRestore: { request: null, actualModel: FABLE } }));
    store.saveExecutionSettings(execution({ model: FABLE, fastMode: false }));
    expect(store.loadExecutionSettings()?.fastRestore).toBeUndefined();
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { execution: Record<string, unknown> };
    expect(raw.execution).not.toHaveProperty("fastRestore");
  });

  it("旧版 Sonnet/on 迁移为 Opus，并保存 Sonnet 基线且幂等", () => {
    writeRaw(execution({ model: "sonnet" }));
    const expected = execution({ model: "opus", fastRestore: { request: "sonnet" } });
    expect(store.loadExecutionSettings()).toEqual(expected);
    const once = fs.readFileSync(file, "utf-8");
    expect(store.loadExecutionSettings()).toEqual(expected);
    expect(fs.readFileSync(file, "utf-8")).toBe(once);
    expect(JSON.parse(once).folder).toBe(dir);
  });

  it("旧版自动/on 与 Opus/on 分别保存 null 和 Opus 基线", () => {
    writeRaw(execution());
    expect(store.loadExecutionSettings()).toEqual(execution({ model: "opus", fastRestore: { request: null } }));
    writeRaw(execution({ model: "opus" }));
    expect(store.loadExecutionSettings()).toEqual(execution({ model: "opus", fastRestore: { request: "opus" } }));
  });

  it("合法的手动 Sonnet/on 与恢复基线在重启时不被迁移", () => {
    const expected = execution({ model: "sonnet", fastRestore: { request: "fable" } });
    writeRaw(expected);
    expect(store.loadExecutionSettings()).toEqual(expected);
  });

  it("非法 restore 不透传；actual 仅允许自动 request 的非空字符串", () => {
    writeRaw({ ...execution({ model: "fable" }), fastRestore: { request: 42, actualModel: FABLE } });
    expect(store.loadExecutionSettings()).toEqual(execution({ model: "opus", fastRestore: { request: "fable" } }));
    writeRaw({ ...execution({ model: "opus" }), fastRestore: { request: null, actualModel: 42 } });
    expect(store.loadExecutionSettings()).toEqual(execution({ model: "opus", fastRestore: { request: null } }));
    writeRaw(execution({ model: "sonnet", fastRestore: { request: "sonnet", actualModel: FABLE } }));
    expect(store.loadExecutionSettings()).toEqual(execution({ model: "sonnet", fastRestore: { request: "sonnet" } }));
  });

  it("fast=false 清理遗留 restore，其他执行字段与绑定保持", () => {
    writeRaw({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: false, fastRestore: { request: null, actualModel: FABLE } });
    expect(store.loadExecutionSettings()).toEqual({ permissionMode: "plan", model: "sonnet", effort: "high", fastMode: false });
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { folder?: string; execution: Record<string, unknown> };
    expect(raw.folder).toBe(dir);
    expect(raw.execution).not.toHaveProperty("fastRestore");
  });
});
