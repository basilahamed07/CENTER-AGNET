/**
 * Byte-bounded output ring buffer.
 *
 * The terminal output buffer must stay bounded in BYTES, not chunk count:
 * a PTY can emit chunks from 1 byte (interactive typing) to 64+ KB (screen
 * redraws), so a fixed chunk cap is effectively unbounded memory. This buffer
 * keeps the most recent `maxBytes` of output, trimmed on whole chunks.
 *
 * Used for:
 *  - reconnect replay: `terminal.attach` sends the buffered tail so the
 *    browser xterm catches up (frontend refresh / late attach).
 *  - a future bounded scrollback export, if ever needed.
 */
export class OutputRingBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error(`OutputRingBuffer maxBytes must be positive, got ${maxBytes}`);
    }
  }

  push(chunk: string) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    this.trim();
  }

  /** Concatenated contents, trimmed to the newest maxBytes. */
  drain(): string {
    return this.chunks.join('');
  }

  get byteLength(): number {
    return this.bytes;
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }

  private trim() {
    // Drop oldest chunks until we are back under the cap. Chunks are small
    // relative to the cap, so dropping a whole chunk never overshoots badly.
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const oldest = this.chunks.shift() as string;
      this.bytes -= Buffer.byteLength(oldest, 'utf8');
    }
    // Degenerate case: one chunk alone exceeds the cap — keep its tail.
    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0] as string;
      // UTF-8 safety: cut on a code-point boundary near the tail.
      const slice = Array.from(only).slice(-Math.floor(this.maxBytes));
      this.chunks = [slice.join('')];
      this.bytes = Buffer.byteLength(this.chunks[0] as string, 'utf8');
    }
  }
}
