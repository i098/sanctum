/** Canonical mono PCM16 WAV reading and writing, and the server's silence gate, for the soak driver. */
import type { FileHandle } from 'node:fs/promises';
import { SampleRate } from '@sanctum/contracts';
import { Schema } from 'effect';

export interface Wav { readonly sample_rate: number; readonly data_offset: number; readonly samples: number }

const SILENCE_RMS = 32_768 * 10 ** (-56 / 20);

/** Whether a frame is above the server's -56 dBFS gate; quieter audio never reaches ASR or extraction. */
export function isSpeech(samples: Int16Array): boolean {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) > SILENCE_RMS;
}

async function readAt(file: FileHandle, length: number, position: number) {
  const bytes = Buffer.alloc(length);
  await file.read(bytes, 0, length, position);
  return bytes;
}

/** The sample rate of a `fmt ` chunk body; only mono PCM16 at a rate the media protocol accepts is allowed. */
function sampleRateOf(fmt: Buffer): number {
  if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt16LE(14) !== 16) throw new Error('audio must be mono PCM16');
  return Schema.decodeUnknownSync(SampleRate)(fmt.readUInt32LE(4));
}

/** Reads the RIFF/WAVE header, skipping unknown chunks. */
export async function readWav(file: FileHandle): Promise<Wav> {
  const { size } = await file.stat();
  const head = await readAt(file, 12, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('audio is not a RIFF/WAVE file');
  let rate = 0;
  for (let at = 12; at + 8 <= size; ) {
    const chunk = await readAt(file, 8, at);
    const id = chunk.toString('ascii', 0, 4);
    const length = chunk.readUInt32LE(4);
    if (id === 'fmt ') rate = sampleRateOf(await readAt(file, 16, at + 8));
    if (id === 'data') {
      if (rate === 0) throw new Error('WAV data chunk before fmt chunk');
      // A streamed WAV may carry a 0 or 0xFFFFFFFF length: trust the file size then.
      const bytes = length === 0 || at + 8 + length > size ? size - at - 8 : length;
      return { sample_rate: rate, data_offset: at + 8, samples: Math.floor(bytes / 2) };
    }
    at += 8 + length + (length % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** The 44-byte-header mono PCM16 WAV the chunk upload route requires. */
export function wavFile(samples: Int16Array, rate: number): Uint8Array {
  const data = samples.byteLength;
  const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + data, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(data, 40);
  Buffer.from(samples.buffer, samples.byteOffset, data).copy(out, 44);
  return out;
}
