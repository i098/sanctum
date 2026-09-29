/**
 * Local recordings orphaned by a removed listener: their chunks can never be uploaded, so a person
 * can export each recording as one WAV and, only by an explicit choice, discard it. Pure helpers;
 * the recovery buffer reads and deletes the chunks.
 */
import type { RecordingChunkManifest } from '@sanctum/contracts';
import { WAV_HEADER_BYTES, wavHeader, type SealedChunk } from './recorder.ts';
import type { OrphanedRecording, RecordingGap } from './view.ts';

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
 * One WAV of the chunks' samples in sample order at the capture rate. Missing ranges are not
 * filled with invented silence; `groupRecordings` reports them as gaps.
 */
export function assembleWav(chunks: readonly SealedChunk[]): Blob {
  const ordered = [...chunks].sort((a, b) => a.manifest.sample_start - b.manifest.sample_start);
  const samples = ordered.reduce((sum, chunk) => sum + chunk.manifest.sample_count, 0);
  const header = wavHeader(samples, ordered[0]?.manifest.sample_rate ?? 0);
  const data = ordered.map((chunk) => chunk.wav.subarray(WAV_HEADER_BYTES) as Uint8Array<ArrayBuffer>);
  return new Blob([header, ...data], { type: 'audio/wav' });
}
