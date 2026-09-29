/**
 * Local recordings orphaned by a removed listener: their chunks can never be uploaded, so a person
 * can export each recording as WAV files and, only by an explicit choice, discard it. Pure helpers;
 * the recovery buffer reads and deletes the chunks.
 */
import type { RecordingChunkManifest } from '@sanctum/contracts';
import { WAV_HEADER_BYTES, wavHeader } from './recorder.ts';
import type { OrphanedRecording, RecordingGap, WavPart } from './view.ts';

/** One chunk's PCM16 samples (no WAV header), held as a Blob so an export never copies a whole recording into memory. */
export interface RecordingSegment {
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly data: Blob;
}

/** Most samples one mono PCM16 WAV file holds: its RIFF sizes are 32-bit. */
export const WAV_MAX_SAMPLES = Math.floor((0xffff_ffff - (WAV_HEADER_BYTES - 8)) / 2);

function describe(manifests: RecordingChunkManifest[]): OrphanedRecording {
  const [first] = manifests.sort((a, b) => a.sample_start - b.sample_start) as [RecordingChunkManifest];
  const gaps: RecordingGap[] = [];
  let expected = first.sample_start;
  let kept = 0;
  for (const manifest of manifests) {
    if (manifest.sample_start > expected) gaps.push({ at: kept, missing: manifest.sample_start - expected });
    expected = manifest.sample_start + manifest.sample_count;
    kept += manifest.sample_count;
  }
  return {
    listenerId: first.listener_id,
    epochId: first.epoch_id,
    sampleRate: first.sample_rate,
    startedAt: first.captured_at,
    sampleCount: kept,
    chunkCount: manifests.length,
    gaps,
  };
}

/** Groups chunk manifests per recording (listener and capture epoch), oldest first. */
export function groupRecordings(manifests: readonly RecordingChunkManifest[]): OrphanedRecording[] {
  const groups = new Map<string, RecordingChunkManifest[]>();
  for (const manifest of manifests) {
    const key = `${manifest.listener_id}/${manifest.epoch_id}`;
    const group = groups.get(key);
    if (group) group.push(manifest);
    else groups.set(key, [manifest]);
  }
  return [...groups.values()].map(describe).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * The segments' samples in sample order at the capture rate, as sequential WAV files of at most
 * `maxSamples` samples each. Missing ranges are not filled with invented silence; `groupRecordings`
 * reports them as gaps.
 */
export function assembleWav(segments: readonly RecordingSegment[], sampleRate: number, maxSamples = WAV_MAX_SAMPLES): WavPart[] {
  const parts: WavPart[] = [];
  let data: Blob[] = [];
  let count = 0;
  let start = 0;
  let end = 0;
  const close = () => {
    if (count > 0) parts.push({ blob: new Blob([wavHeader(count, sampleRate), ...data], { type: 'audio/wav' }), sampleStart: start, sampleEnd: end });
    data = [];
    count = 0;
  };
  for (const segment of [...segments].sort((a, b) => a.sampleStart - b.sampleStart)) {
    for (let offset = 0; offset < segment.sampleCount;) {
      if (count === maxSamples) close();
      if (count === 0) start = segment.sampleStart + offset;
      const take = Math.min(segment.sampleCount - offset, maxSamples - count);
      data.push(segment.data.slice(offset * 2, (offset + take) * 2));
      offset += take;
      count += take;
      end = segment.sampleStart + offset;
    }
  }
  close();
  return parts;
}
