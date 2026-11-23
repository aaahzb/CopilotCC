import assert from "node:assert/strict";

export const GRACEFUL_SHUTDOWN_STAGES = Object.freeze([
  "shutdown.server start",
  "shutdown.watcher closed",
  "shutdown.embedded closed",
  "shutdown.ws start clients=",
  "shutdown.ws clients settled",
  "shutdown.wss closed",
  "shutdown.http closed",
  "shutdown.sdk closed",
  "shutdown.server settled",
  "shutdown.runtime released",
]);

/**
 * 核对一次正常关闭的实际诊断顺序，防止进程或子进程直接死亡被误判为服务清理成功。
 * @param {string} log 本次关闭新增的 startup-diag.log 内容
 * @param {{signal?: string}} options 预期控制台信号
 * @returns {string[]} 按顺序匹配到的诊断事件
 */
export function assertGracefulShutdownLog(log, { signal = "SIGBREAK" } = {}) {
  const messages = log.split(/\r?\n/).map((line) => /\[diag\] (shutdown\..+)$/.exec(line)?.[1])
    .filter((message) => message !== undefined);
  assert(!messages.includes("shutdown.server rejected"), `正常关闭服务失败：${messages.join(" -> ")}`);
  const expected = [`shutdown.signal ${signal}`, ...GRACEFUL_SHUTDOWN_STAGES];
  const matched = [];
  let previous = -1;
  for (const marker of expected) {
    const index = messages.findIndex((message, position) => position > previous
      && (marker.endsWith("=") ? message.startsWith(marker) : message === marker));
    assert(index > previous, `正常关闭缺少或乱序：${marker}；实际=${messages.join(" -> ") || "无"}`);
    matched.push(messages[index]);
    previous = index;
  }
  return matched;
}

/**
 * 定向 Console 关闭不得靠测试专用 SIGBREAK 处理器让 SDK 假 CLI 存活。
 * @param {Array<{kind?: string, signal?: string, pid?: number}>} events 本次关闭新增的假 CLI 事件
 * @returns 无返回值；收到组信号时抛出
 */
export function assertNoFakeSigbreak(events) {
  const received = events.filter((event) => event.kind === "signal" && event.signal === "SIGBREAK");
  assert(received.length === 0, `定向关闭误投递到 SDK 假 CLI：${received.map((event) => event.pid).join(",")}`);
}
