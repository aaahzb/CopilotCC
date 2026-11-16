import fs from "node:fs";
import path from "node:path";

/**
 * 临时启动诊断（2026-11-16）：定位 Windows 终端启动 ~8s 卡顿用，排查完成后整份移除。
 * 只写本地诊断文件，不改变任何生产行为；任何写入失败都静默。
 */
let logDir: string | null = null;
/** 事件循环心跳定时器；只在启用后创建一次。 */
let timer: ReturnType<typeof setInterval> | null = null;
/** 上一次心跳的时间戳。 */
let lastTick = 0;
/** 心跳间隔；明显超期说明主线程被同步代码占住。 */
const TICK_MS = 100;
/** 只有超过该阈值的延迟才记录，避免日志噪音。 */
const LAG_THRESHOLD_MS = 200;

/**
 * 追加一行诊断日志。
 * @param text 不含敏感信息的诊断文本
 */
export function diagLog(text: string): void {
  const dir = logDir;
  if (!dir) return;
  const line = `${new Date().toISOString()} [diag] ${text}\n`;
  void fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => fs.promises.appendFile(path.join(dir, "startup-diag.log"), line, { encoding: "utf8", mode: 0o600 }))
    .catch(() => undefined);
}

/**
 * 记录一段同步耗时；低于阈值不写，避免日志噪音。
 * @param label 阶段名（不得含用户内容）
 * @param startedAt Date.now() 起点
 * @param detail 附加上下文（不得含用户内容）
 */
export function diagSlow(label: string, startedAt: number, detail = ""): void {
  const ms = Date.now() - startedAt;
  if (ms >= 100) diagLog(`${label} ${ms}ms${detail ? ` ${detail}` : ""}`);
}

/**
 * 启用启动诊断：事件循环延迟采样 + 诊断行落盘。
 * @param dir 配置根目录，日志写在 `dir/startup-diag.log`；传 null 关闭
 */
export function enableStartupDiagnostics(dir: string | null): void {
  logDir = dir;
  if (!dir || timer) return;
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - TICK_MS;
    lastTick = now;
    if (lag >= LAG_THRESHOLD_MS) diagLog(`event-loop blocked ~${lag}ms`);
  }, TICK_MS);
  timer.unref?.();
  diagLog("diagnostics enabled");
}
