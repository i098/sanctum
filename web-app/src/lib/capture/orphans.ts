/**
 * Local recordings orphaned by a removed listener: their chunks can never be uploaded, so a person
 * can export each recording as WAV files and, only by an explicit choice, discard it. Pure helpers;
 * the recovery buffer reads and deletes the chunks.
 */
import type { RecordingChunkManifest } from '@sanctum/contracts';
import { WAV_HEADER_BYTES, wavHeader } from './recorder.ts';
import type { OrphanedRecording, RecordingGap, RecordingPart, WavPart } from './view.ts';

/** One chunk's PCM16 samples (no WAV header), held as a Blob so an export never copies a whole recording into memory. */
export interface RecordingSegment {
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly data: Blob;
}

/** Most samples one mono PCM16 WAV file holds: its RIFF sizes are 32-bit. */
export const WAV_MAX_SAMPLES = Math.floor((0xffff_ffff - (WAV_HEADER_BYTES - 8)) / 2);

interface Span {
  readonly sampleStart: number;
  readonly sampleCount: number;
}

/**
 * Lays spans out in sample order as WAV files of at most `maxSamples` kept samples each, on the
 * capture sample clock; `take` receives every piece with the index of the file it belongs to.
 * Missing ranges are not filled with invented silence: each is a gap of the file it falls inside.
 */
function layout<S extends Span>(spans: readonly S[], maxSamples: number, take: (part: number, span: S, offset: number, count: number) => void = () => { }): RecordingPart[] {
  const parts: { sampleStart: number; sampleEnd: number; gaps: RecordingGap[] }[] = [];
  let kept = maxSamples;
  for (const span of [...spans].sort((a, b) => a.sampleStart - b.sampleStart)) {
    for (let offset = 0; offset < span.sampleCount;) {
      const at = span.sampleStart + offset;
      if (kept === maxSamples) {
        parts.push({ sampleStart: at, sampleEnd: at, gaps: [] });
        kept = 0;
      }
      const part = parts.at(-1)!;
      if (at > part.sampleEnd) part.gaps.push({ at: part.sampleEnd, missing: at - part.sampleEnd });
      const count = Math.min(span.sampleCount - offset, maxSamples - kept);
      take(parts.length - 1, span, offset, count);
      offset += count;
      kept += count;
      part.sampleEnd = at + count;
    }
  }
  return parts;
}

function describe(manifests: RecordingChunkManifest[], maxSamples: number): OrphanedRecording {
  const [first] = manifests.sort((a, b) => a.sample_start - b.sample_start) as [RecordingChunkManifest];
  return {
    listenerId: first.listener_id,
    epochId: first.epoch_id,
    sampleRate: first.sample_rate,
    startedAt: first.captured_at,
    sampleCount: manifests.reduce((sum, manifest) => sum + manifest.sample_count, 0),
    chunkCount: manifests.length,
    parts: layout(manifests.map((manifest) => ({ sampleStart: manifest.sample_start, sampleCount: manifest.sample_count })), maxSamples),
  };
}

/** Groups chunk manifests per recording (listener and capture epoch), oldest first, with the WAV files an export writes. */
export function groupRecordings(manifests: readonly RecordingChunkManifest[], maxSamples = WAV_MAX_SAMPLES): OrphanedRecording[] {
  const groups = new Map<string, RecordingChunkManifest[]>();
  for (const manifest of manifests) {
    const key = `${manifest.listener_id}/${manifest.epoch_id}`;
    const group = groups.get(key);
    if (group) group.push(manifest);
    else groups.set(key, [manifest]);
  }
  return [...groups.values()].map((group) => describe(group, maxSamples)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** WAV file `part` of the segments' samples at the capture rate, laid out as `groupRecordings` lists it; null when there is no such file. */
export function assembleWav(segments: readonly RecordingSegment[], sampleRate: number, part: number, maxSamples = WAV_MAX_SAMPLES): WavPart | null {
  const data: Blob[] = [];
  let count = 0;
  const range = layout(segments, maxSamples, (index, segment, offset, take) => {
    if (index !== part) return;
    data.push(segment.data.slice(offset * 2, (offset + take) * 2));
    count += take;
  })[part];
  return range === undefined ? null : { blob: new Blob([wavHeader(count, sampleRate), ...data], { type: 'audio/wav' }), sampleStart: range.sampleStart, sampleEnd: range.sampleEnd };
}
