/**
 * AudioWorklet recording tap (plan 04/05): converts render quanta to PCM16 blocks drawn from a
 * fixed pool. A block is transferred to the main thread and only rejoins the pool when the
 * consumer transfers it back, so no bytes are overwritten while still owned downstream.
 * An exhausted pool drops samples but keeps the sample clock, so the next block's `sampleStart`
 * shows the dropped range and the archive records it as a gap instead of shifting later audio.
 */
export const RECORDER_PROCESSOR = 'sanctum-recorder';
/** 50 ms blocks, inside the 20-100 ms live frame range. */
const BLOCKS_PER_SECOND = 20;
/** Two seconds of main-thread stall before samples are dropped. */
const BLOCK_POOL_SIZE = 2 * BLOCKS_PER_SECOND;

export type WorkletMessage =
  | { readonly type: 'block'; readonly sampleStart: number; readonly count: number; readonly samples: Int16Array }
  | { readonly type: 'flushed' };

export type MainMessage = { readonly type: 'release'; readonly samples: Int16Array } | { readonly type: 'flush' };

type Post = (message: WorkletMessage, transfer?: Transferable[]) => void;

export class PcmBlockWriter {
  private readonly free: Int16Array[] = [];
  private readonly blockSize: number;
  private readonly post: Post;
  private current: Int16Array | null = null;
  private filled = 0;
  private blockStart = 0;
  private next = 0;

  constructor(blockSize: number, poolSize: number, post: Post) {
    this.blockSize = blockSize;
    this.post = post;
    for (let i = 0; i < poolSize; i++) this.free.push(new Int16Array(blockSize));
  }

  /** Returns a block whose consumer has finished; foreign or detached arrays are ignored. */
  release(samples: Int16Array): void {
    if (samples.length === this.blockSize) this.free.push(samples);
  }

  write(input: Float32Array): void {
    let offset = 0;
    while (offset < input.length) {
      if (this.current === null && !this.take(input.length - offset)) return;
      const block = this.current!;
      const count = Math.min(input.length - offset, this.blockSize - this.filled);
      for (let i = 0; i < count; i++) {
        const value = Math.max(-1, Math.min(1, input[offset + i]!));
        block[this.filled + i] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
      }
      this.filled += count;
      offset += count;
      this.next += count;
      if (this.filled === this.blockSize) this.emit();
    }
  }

  /** Posts the partial block, then `flushed`, so the consumer knows every earlier sample arrived. */
  flush(): void {
    if (this.current !== null && this.filled > 0) this.emit();
    this.post({ type: 'flushed' });
  }

  private take(remaining: number): boolean {
    const block = this.free.pop();
    if (block === undefined) {
      this.next += remaining;
      return false;
    }
    this.current = block;
    this.filled = 0;
    this.blockStart = this.next;
    return true;
  }

  private emit(): void {
    const samples = this.current!;
    this.post({ type: 'block', sampleStart: this.blockStart, count: this.filled, samples }, [samples.buffer]);
    this.current = null;
    this.filled = 0;
  }
}

declare const registerProcessor: ((name: string, processor: unknown) => void) | undefined;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

if (typeof registerProcessor === 'function') {
  registerProcessor(
    RECORDER_PROCESSOR,
    class extends AudioWorkletProcessor {
      private readonly writer = new PcmBlockWriter(Math.round(sampleRate / BLOCKS_PER_SECOND), BLOCK_POOL_SIZE, (message, transfer) =>
        this.port.postMessage(message, transfer ?? []),
      );

      constructor() {
        super();
        this.port.onmessage = ({ data }: MessageEvent<MainMessage>) => {
          if (data.type === 'release') this.writer.release(data.samples);
          else this.writer.flush();
        };
      }

      process(inputs: Float32Array[][]): boolean {
        const channel = inputs[0]?.[0];
        if (channel !== undefined) this.writer.write(channel);
        return true;
      }
    },
  );
}
