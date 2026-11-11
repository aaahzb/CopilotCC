/** 一个带单调序号的原始终端输出块。 */
export interface OutputChunk {
  seq: number;
  data: string;
}

/** attach 后可补发的输出页；gap=true 表示屏幕已不连续。 */
export interface ReplayPage {
  gap: boolean;
  latestSeq: number;
  chunks: OutputChunk[];
}

/** 重放缓冲的硬限制。 */
export interface TerminalOutputBufferLimits {
  maxBytes: number;
  maxChunks: number;
}

/** 每个内嵌终端 lease 独立持有的有界原始输出缓冲。 */
export class TerminalOutputBuffer {
  private chunks: OutputChunk[] = [];
  private bytes = 0;
  private seq = 0;

  /** @param limits 默认 1 MiB、256 块的容量限制。 */
  constructor(private readonly limits: TerminalOutputBufferLimits = { maxBytes: 1_048_576, maxChunks: 256 }) {}

  /**
   * 追加完整字符串块，不按字节截断 UTF-8。
   * @param data PTY 原始输出。
   * @returns 新块；空字符串不占用序号并返回 null。
   */
  append(data: string): OutputChunk | null {
    if (data.length === 0) return null;
    const chunk = { seq: ++this.seq, data };
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(data, "utf8");
    this.trim();
    return chunk;
  }

  /**
   * 返回 afterSeq 之后的全部保留块，并明确标记无法补齐的缺口。
   * @param afterSeq 调用方已连续接收的最后序号。
   * @returns 重放页；即使当前没有保留块，也不会把清空期间的数据伪装成连续。
   * @throws {Error} 序号非法或超过 latestSeq 时抛出 FUTURE_SEQ。
   */
  since(afterSeq: number): ReplayPage {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > this.seq) throw new Error("FUTURE_SEQ");
    const first = this.chunks[0];
    const gap = afterSeq < this.seq && (!first || first.seq > afterSeq + 1);
    return {
      gap,
      latestSeq: this.seq,
      chunks: this.chunks.filter((chunk) => chunk.seq > afterSeq),
    };
  }

  /** @returns 最近分配的序号；clear 不回退。 */
  latestSeq(): number {
    return this.seq;
  }

  /** @returns 清空保留块但保留序号，防止迟到输出复用旧 seq。 */
  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  /** @returns 无；容量超限时从最旧块开始丢弃，至少保留最新完整块。 */
  private trim(): void {
    while (this.chunks.length > 1 && (this.bytes > this.limits.maxBytes || this.chunks.length > this.limits.maxChunks)) {
      const removed = this.chunks.shift()!;
      this.bytes -= Buffer.byteLength(removed.data, "utf8");
    }
  }
}
