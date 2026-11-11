import fs from "node:fs";
import path from "node:path";
import { UUID_RE } from "./protocol";
import { slugifyPath, transcriptProjectsRoot } from "./transcript";

interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

export interface TranscriptWatcherDeps {
  debounceMs?: number;
  reconcileMs?: number;
  onList(): void;
  onTranscript(sessionId: string): void;
}

/** 监听某工作目录的 Claude JSONL；fs.watch 只提醒对账，文件快照才是事实来源。 */
export class TranscriptWatcher {
  private dir: string | null = null;
  private watch: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private snapshot = new Map<string, FileFingerprint>();
  private readonly debounceMs: number;
  private readonly reconcileMs: number;

  constructor(private readonly deps: TranscriptWatcherDeps) {
    this.debounceMs = deps.debounceMs ?? 250;
    this.reconcileMs = deps.reconcileMs ?? 2000;
  }

  /**
   * 绑定新的工作目录并建立不触发通知的初始基线。
   * @param folder 当前工作区文件夹，不是 projects 子目录本身
   */
  bind(folder: string): void {
    this.close();
    this.dir = path.join(transcriptProjectsRoot(), slugifyPath(path.resolve(folder)));
    this.snapshot = this.scan() ?? new Map();
    this.ensureWatch();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileMs);
    this.reconcileTimer.unref();
  }

  /**
   * 幂等比较目录快照：新增/删除只额外刷新列表，新增/修改通知对应转录。
   * 目录暂不存在视为空；其他读取错误保留旧快照，避免误报全部删除。
   */
  reconcile(): void {
    if (!this.dir) return;
    const next = this.scan();
    if (!next) return;
    this.ensureWatch();
    const previous = this.snapshot;
    this.snapshot = next;
    let listChanged = false;
    const changed: string[] = [];
    for (const [sessionId, fingerprint] of next) {
      const old = previous.get(sessionId);
      if (!old) {
        listChanged = true;
        changed.push(sessionId);
      } else if (old.mtimeMs !== fingerprint.mtimeMs || old.size !== fingerprint.size) {
        changed.push(sessionId);
      }
    }
    for (const sessionId of previous.keys()) {
      if (!next.has(sessionId)) listChanged = true;
    }
    if (listChanged) this.deps.onList();
    for (const sessionId of changed.sort()) this.deps.onTranscript(sessionId);
  }

  /** 停止监听与计时器；重复调用安全，不影响已落盘的转录。 */
  close(): void {
    this.watch?.close();
    this.watch = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.debounceTimer = null;
    this.reconcileTimer = null;
    this.dir = null;
    this.snapshot = new Map();
  }

  /** 读取规范 UUID 转录的指纹，忽略目录中无关文件和刚好消失的条目。 */
  private scan(): Map<string, FileFingerprint> | null {
    if (!this.dir) return null;
    const next = new Map<string, FileFingerprint>();
    try {
      for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const sessionId = entry.name.slice(0, -".jsonl".length);
        if (!UUID_RE.test(sessionId)) continue;
        try {
          const stat = fs.statSync(path.join(this.dir, entry.name));
          next.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // 文件在枚举和 stat 之间被移动/删除，由下次对账确认，不伪造事件。
        }
      }
      return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return next;
      return null;
    }
  }

  /** 目录存在且尚未监听时补挂 fs.watch；事件本身不提供可信 sessionId。 */
  private ensureWatch(): void {
    if (!this.dir || this.watch || !fs.existsSync(this.dir)) return;
    try {
      const watcher = fs.watch(this.dir, () => this.schedule());
      watcher.on("error", () => {
        if (this.watch === watcher) this.watch = null;
        watcher.close();
      });
      this.watch = watcher;
    } catch {
      // 某些文件系统不支持 watch；2 秒对账仍提供有界发现延迟。
    }
  }

  /** 合并密集写入，随后统一走 reconcile，避免重复广播同一文件。 */
  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reconcile();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }
}
