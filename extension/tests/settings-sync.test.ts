import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/lib/storage";
import type { ServerMessage } from "../src/lib/protocol";
import {
  hasExecutionSettingsChange,
  mergeDoneRuntime,
  mirrorExecutionSettings,
  runtimeFromSettingsState,
  toFastSettingsSet,
  toSettingsSet,
} from "../src/lib/settings-sync";

function state(runtime?: Extract<ServerMessage, { type: "settings.state" }>["runtime"]): Extract<ServerMessage, { type: "settings.state" }> {
  return { type: "settings.state", permissionMode: "auto", fastMode: false, ...(runtime !== undefined ? { runtime } : {}) };
}

describe("执行设置与桥接协议同步", () => {
  it("启动和手动设置都完整携带 fast，显式 false 不丢失", () => {
    const settings = { ...DEFAULTS, token: "secret", permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    expect(toSettingsSet(settings)).toEqual({ type: "settings.set", permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true });
    expect(toSettingsSet({ ...settings, fastMode: false })).toMatchObject({ fastMode: false });
  });

  it("settings.state 只镜像执行字段，保留连接与其他本地偏好", () => {
    const current = { ...DEFAULTS, token: "secret", port: 23456, attachEnabled: false, fastMode: true };
    const next = mirrorExecutionSettings(current, {
      type: "settings.state", permissionMode: "acceptEdits", model: "fable", effort: "max", fastMode: false,
    });
    expect(next).toMatchObject({ token: "secret", port: 23456, attachEnabled: false, permissionMode: "acceptEdits", model: "fable", effort: "max", fastMode: false });
  });

  it("chat.done 只有 fast 真值时保留模型和 effort，缺字段不清缓存", () => {
    const current = { model: "claude-fable-5-1", effort: "high" as const, fast: { state: "off" as const } };
    const next = mergeDoneRuntime(current, { type: "chat.done", sessionId: "s", fast: { state: "cooldown", disabledReason: "network_error" } });
    expect(next).toEqual({ ...current, fast: { state: "cooldown", disabledReason: "network_error" } });
    expect(mergeDoneRuntime(next, { type: "chat.done", sessionId: "s" })).toEqual(next);
  });

  it("chat.done 的 effort null 表示实际未下发，不能回退请求值", () => {
    const next = mergeDoneRuntime({ model: "old", effort: "high" }, { type: "chat.done", sessionId: "s", model: "new", effort: null });
    expect(next).toEqual({ model: "new", effort: null });
  });

  it("settings.state 缺 runtime 保留缓存，显式空对象清除，部分快照整体替换", () => {
    const current = { model: "old", effort: "high" as const, fast: { state: "on" as const } };
    expect(runtimeFromSettingsState(current, state())).toEqual(current);
    expect(runtimeFromSettingsState(current, state({}))).toEqual({});
    expect(runtimeFromSettingsState(current, state({ model: "new" }))).toEqual({ model: "new" });
  });

  it("仅 runtime 更新不算请求设置变化，真正 fast 变化才清除旧设置错误", () => {
    const current = { ...DEFAULTS, fastMode: false };
    expect(hasExecutionSettingsChange(current, state({ model: "new" }))).toBe(false);
    expect(hasExecutionSettingsChange(current, { ...state(), fastMode: true })).toBe(true);
  });


  it("手动字段补丁携带掩码，完整快照里的旧 fast 不成为变更意图", () => {
    const settings = { ...DEFAULTS, permissionMode: "auto" as const, model: "fable", effort: "low" as const, fastMode: true };
    expect(toSettingsSet(settings, false, ["model"])).toEqual({
      type: "settings.set", permissionMode: "auto", model: "fable", effort: "low", fastMode: true, fields: ["model"],
    });
  });

  it("手动 fast 切换声明 fastOnly，同时保留完整字段兼容旧桥", () => {
    const settings = { ...DEFAULTS, permissionMode: "plan" as const, model: "sonnet", effort: "high" as const, fastMode: true };
    expect(toFastSettingsSet(settings)).toEqual({
      type: "settings.set", permissionMode: "plan", model: "sonnet", effort: "high", fastMode: true, fastOnly: true,
    });
  });


  it("服务器 fastPending 且 runtime 缺省时只清 fast，发起视图也不依赖乐观 ref", () => {
    const current = { model: "old", effort: "high" as const, fast: { state: "on" as const } };
    const message = { ...state(), fastMode: true, fastPending: true };
    expect(runtimeFromSettingsState(current, message)).toEqual({ model: "old", effort: "high" });
    expect(runtimeFromSettingsState(current, { ...message, fastPending: false })).toBe(current);
  });

  it("自动 hello 明确声明播种意图，手动完整设置不声明", () => {
    const settings = { ...DEFAULTS, permissionMode: "plan" as const, model: "sonnet", fastMode: true };
    expect(toSettingsSet(settings, true)).toMatchObject({ type: "settings.set", permissionMode: "plan", model: "sonnet", fastMode: true, hello: true });
    expect(toSettingsSet(settings)).not.toHaveProperty("hello");
  });

});
