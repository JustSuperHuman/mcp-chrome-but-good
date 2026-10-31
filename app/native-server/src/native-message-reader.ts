const EMPTY_BUFFER = Buffer.alloc(0);

/** Length-prefixed native messages without repeatedly copying a partial body. */
export class NativeMessageReader {
  private chunks: Buffer[] = [];
  private head = 0;
  private offset = 0;
  private available = 0;
  private expectedLength: number | null = null;

  constructor(private readonly maxMessageSize = 16 * 1024 * 1024) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.available += chunk.length;
  }

  get hasPendingData(): boolean {
    return this.available > 0;
  }

  readMessage(): Buffer | null {
    if (this.expectedLength === null) {
      if (this.available < 4) return null;
      const length = this.consume(4).readUInt32LE(0);
      if (length === 0 || length > this.maxMessageSize) {
        this.reset();
        throw new Error(`Invalid message length: ${length}`);
      }
      this.expectedLength = length;
    }
    if (this.available < this.expectedLength) return null;
    const message = this.consume(this.expectedLength);
    this.expectedLength = null;
    return message;
  }

  private reset(): void {
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.available = 0;
    this.expectedLength = null;
  }

  private consume(length: number): Buffer {
    const first = this.chunks[this.head];
    // Most small messages arrive intact and need no body allocation at all.
    const result =
      first.length - this.offset >= length
        ? first.subarray(this.offset, this.offset + length)
        : Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.head];
      const count = Math.min(length - written, chunk.length - this.offset);
      if (result.buffer !== chunk.buffer || result.byteOffset !== chunk.byteOffset + this.offset) {
        chunk.copy(result, written, this.offset, this.offset + count);
      }
      written += count;
      this.offset += count;
      if (this.offset === chunk.length) {
        // Release the backing buffer even before the queue array is compacted.
        this.chunks[this.head++] = EMPTY_BUFFER;
        this.offset = 0;
      }
    }
    this.available -= length;
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return result;
  }
}
