import assert from "node:assert/strict";
import test from "node:test";
import { assertGracefulShutdownLog, assertNoFakeSigbreak, GRACEFUL_SHUTDOWN_STAGES } from "./shutdown-diagnostics.mjs";

function diagnostics(messages) {
  return messages.map((message, index) => `2026-11-24T00:00:${String(index).padStart(2, "0")}.000Z [diag] ${message}`).join("\n");
}

test("正常关闭诊断接受完整顺序和动态 WS 客户端数", () => {
  const events = ["shutdown.signal SIGBREAK", ...GRACEFUL_SHUTDOWN_STAGES];
  const log = diagnostics(events.map((event) => event === "shutdown.ws start clients=" ? `${event}3` : event));
  assert.deepEqual(assertGracefulShutdownLog(log), events.map((event) => event === "shutdown.ws start clients=" ? `${event}3` : event));
});

test("正常关闭诊断拒绝缺阶段、乱序和错误信号", () => {
  const events = ["shutdown.signal SIGBREAK", ...GRACEFUL_SHUTDOWN_STAGES];
  assert.throws(() => assertGracefulShutdownLog(diagnostics(events.slice(0, -1))), /shutdown.runtime released/);
  assert.throws(() => assertGracefulShutdownLog(diagnostics([events[1], events[0], ...events.slice(2)])), /shutdown.signal SIGBREAK/);
  assert.throws(() => assertGracefulShutdownLog(diagnostics(["shutdown.signal SIGINT", ...events.slice(1)])), /shutdown.signal SIGBREAK/);
});

test("正常关闭诊断拒绝服务关闭异常", () => {
  const events = ["shutdown.signal SIGBREAK", ...GRACEFUL_SHUTDOWN_STAGES, "shutdown.server rejected"];
  assert.throws(() => assertGracefulShutdownLog(diagnostics(events)), /正常关闭服务失败/);
});

test("定向关闭拒绝靠假 CLI 忽略处理器制造假通过", () => {
  assert.doesNotThrow(() => assertNoFakeSigbreak([
    { kind: "start", pid: 41 },
    { kind: "signal-handler", signal: "SIGBREAK", pid: 41 },
  ]));
  assert.throws(() => assertNoFakeSigbreak([
    { kind: "signal-handler", signal: "SIGBREAK", pid: 41 },
    { kind: "signal", signal: "SIGBREAK", pid: 41 },
  ]), /误投递到 SDK 假 CLI：41/);
});
