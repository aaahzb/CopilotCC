import fs from "node:fs";
import path from "node:path";

/** 生产入口启用的日志目录；null 表示关闭，测试与 selftest 缺省不落盘。 */
let logDir: string | null = null;

/** 作用域与标签名的安全字符；拒绝空格、换行和控制字符，避免伪造日志行。 */
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,40}$/;
/** 标签值同样只允许安全字符，且不包含敏感路径或 token。 */
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,60}$/;

/**
 * 启用启动耗时日志，只应由常驻入口在解析配置目录后调用。
 * @param dir 配置根目录，日志写在 `dir/startup.log`；传 null 关闭
 */
export function enableStartupTiming(dir: string | null): void {
  logDir = dir;
}

/**
 * 一次终端启动的分段计时器。只做 `Date.now()` 差值并异步追加一行，
 * 不等待、不抛错，任何失败都静默跳过，绝不拖慢启动。
 */
export class StartupTiming {
  private readonly startedAt = Date.now();
  private readonly marks: Array<{ name: string; at: number }> = [];
  private readonly tags: Array<{ name: string; value: string }> = [];
  private flushed = 0;

  /** @param scope 启动作用域，如 embedded/system/terminal.open */
  constructor(private readonly scope: string) {}

  /**
   * 记录一个阶段的结束时间点。
   * @param name 阶段名，只允许安全字符
   */
  mark(name: string): void {
    if (!SAFE_NAME.test(name)) return;
    this.marks.push({ name, at: Date.now() });
  }

  /**
   * 记录只用于标注、不参与计时的标签，如真实后端名称。
   * @param name 标签名
   * @param value 标签值，只允许安全字符
   */
  tag(name: string, value: string): void {
    if (!SAFE_NAME.test(name) || !SAFE_VALUE.test(value)) return;
    this.tags.push({ name, value });
  }

  /**
   * 异步追加自上次 flush 以来的阶段；目录未启用、没有新阶段或写入失败都静默处理。
   * @returns 写入尝试结束的 Promise；调用方不得等待，以保持启动链不阻塞
   */
  flush(): Promise<void> {
    const dir = logDir;
    const startIndex = this.flushed;
    const fresh = this.marks.slice(startIndex);
    if (!dir || fresh.length === 0) return Promise.resolve();
    this.flushed = this.marks.length;
    let previousAt = startIndex > 0 ? this.marks[startIndex - 1]!.at : this.startedAt;
    const parts: string[] = [];
    for (const mark of fresh) {
      parts.push(`${mark.name}=${mark.at - previousAt}ms`);
      previousAt = mark.at;
    }
    const scope = SAFE_NAME.test(this.scope) ? this.scope : "unknown";
    const tags = this.tags.map((tag) => ` ${tag.name}=${tag.value}`).join("");
    const total = Date.now() - this.startedAt;
    const line = `${new Date().toISOString()} [startup] ${scope}${tags} ${parts.join(" ")} total=${total}ms\n`;
    return fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => fs.promises.appendFile(path.join(dir, "startup.log"), line, { encoding: "utf8", mode: 0o600 }))
      .then(() => undefined)
      .catch(() => undefined);
  }
}
