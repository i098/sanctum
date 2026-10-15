/**
 * Audio the soak driver plays: one WAV, or the corpus manifest's meetings laid on its timeline. A meeting's WAV
 * starts at its `start_s`; the rest of its slot (the gap) and any unbuilt slot read as silence, so a sample's
 * position is its offset from T0 whichever source is used.
 */
import { type FileHandle, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readWav, type Wav } from './wav.ts';

interface Piece { readonly start: number; readonly wav: Wav; readonly file: FileHandle }

export interface Source {
  readonly rate: number;
  readonly samples: number;
  /** `count` samples from `start`; positions with no audio are zeros. */
  read(start: number, count: number): Promise<Int16Array>;
  close(): Promise<void>;
}

function sourceOf(rate: number, pieces: ReadonlyArray<Piece>, samples: number): Source {
  return {
    rate,
    samples,
    async read(start, count) {
      const out = new Int16Array(count);
      for (const piece of pieces) {
        const from = Math.max(start, piece.start);
        const to = Math.min(start + count, piece.start + piece.wav.samples);
        if (to <= from) continue;
        const view = new Uint8Array(out.buffer, (from - start) * 2, (to - from) * 2);
        // ponytail: little-endian host assumed, like the WAV format; add a byte swap if this ever runs on big-endian.
        const { bytesRead } = await piece.file.read(view, 0, view.byteLength, piece.wav.data_offset + (from - piece.start) * 2);
        if (bytesRead !== view.byteLength) throw new Error(`short read at sample ${from}`);
      }
      return out;
    },
    async close() {
      await Promise.all(pieces.map(piece => piece.file.close()));
    },
  };
}

export async function wavSource(path: string): Promise<Source> {
  const file = await open(path, 'r');
  const wav = await readWav(file);
  return sourceOf(wav.sample_rate, [{ start: 0, wav, file }], wav.samples);
}

interface ManifestMeeting { readonly start_s: number; readonly end_s: number; readonly audio: { readonly file: string } | null }
interface Manifest { readonly sample_rate: number; readonly schedule: ReadonlyArray<ManifestMeeting> }

/** Meetings with built audio at their slot start; the source ends where the last built slot ends. */
export async function manifestSource(manifestPath: string, manifest: Manifest): Promise<Source> {
  const pieces: Piece[] = [];
  let samples = 0;
  try {
    for (const meeting of manifest.schedule) {
      if (meeting.audio === null) continue;
      const file = await open(join(dirname(manifestPath), meeting.audio.file), 'r');
      const wav = await readWav(file);
      const start = Math.round(meeting.start_s * manifest.sample_rate);
      pieces.push({ start, wav, file });
      if (wav.sample_rate !== manifest.sample_rate) throw new Error(`${meeting.audio.file} is ${wav.sample_rate} Hz, manifest says ${manifest.sample_rate}`);
      if (start + wav.samples > Math.round(meeting.end_s * manifest.sample_rate)) throw new Error(`${meeting.audio.file} is longer than its slot`);
      samples = Math.round(meeting.end_s * manifest.sample_rate);
    }
  } catch (error) {
    await Promise.all(pieces.map(piece => piece.file.close()));
    throw error;
  }
  if (pieces.length === 0) throw new Error('manifest has no built audio');
  return sourceOf(manifest.sample_rate, pieces, samples);
}
