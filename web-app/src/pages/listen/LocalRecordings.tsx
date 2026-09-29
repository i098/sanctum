import { useEffect, useId, useRef, useState } from 'react';
import type { CaptureView, OrphanedRecording } from '../../lib/capture/view.ts';
import { Dialog } from './Dialog.tsx';

/** m:ss or h:mm:ss of `samples` on the capture sample clock. */
function clock(samples: number, rate: number): string {
  const seconds = Math.round(samples / rate);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function describe(recording: OrphanedRecording): string {
  const started = new Date(recording.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  return `${started} · ${clock(recording.sampleCount, recording.sampleRate)} · ${recording.chunkCount} chunks`;
}

function download(blob: Blob, recording: OrphanedRecording): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sanctum-${recording.startedAt.replaceAll(':', '-')}-${recording.epochId.slice(0, 8)}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
}

interface LocalRecordingsProps {
  engine: CaptureView;
  /** Stranded chunk count from the capture snapshot; the list reloads when it changes. */
  stranded: number;
}

/**
 * Recordings orphaned by a removed listener, which can never be uploaded. Export (a WAV built in
 * the browser) is the primary action; discard is separate, confirmed, and deletes only that
 * recording. Nothing is deleted automatically and capture keeps running throughout.
 */
export function LocalRecordings({ engine, stranded }: LocalRecordingsProps) {
  const [recordings, setRecordings] = useState<readonly OrphanedRecording[]>([]);
  const [confirming, setConfirming] = useState<OrphanedRecording | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const fail = (error: unknown): void => setFailure(`Local recordings unavailable: ${error instanceof Error ? error.message : String(error)}`);
  useEffect(() => {
    if (stranded === 0) return setRecordings([]);
    let current = true;
    engine.orphanedRecordings().then(list => current && setRecordings(list), (error: unknown) => current && fail(error));
    return () => void (current = false);
  }, [engine, stranded]);

  const exportWav = (recording: OrphanedRecording): void => {
    setFailure(null);
    engine.exportRecording(recording).then(blob => download(blob, recording), fail);
  };
  const discard = (recording: OrphanedRecording): void => {
    setConfirming(null);
    setFailure(null);
    engine.discardRecording(recording).then(() => heading.current?.focus(), fail);
  };

  return (
    <section className="listen-panel listen-local" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>Local recordings that cannot be uploaded</h3>
      {recordings.length === 0 ? (
        <p>None on this device.</p>
      ) : (
        <ul className="listen-items">
          {recordings.map((recording, index) => (
            <li key={`${recording.listenerId}/${recording.epochId}`}>
              <p id={`${id}-${index}`}>{describe(recording)} · listener removed</p>
              {recording.gaps.map(gap => (
                <p key={gap.at} className="listen-local-gap">
                  Gap: {clock(gap.missing, recording.sampleRate)} missing after {clock(gap.at, recording.sampleRate)}, not filled in the export
                </p>
              ))}
              <div className="listen-local-actions">
                <button type="button" data-primary aria-describedby={`${id}-${index}`} onClick={() => exportWav(recording)}>Export WAV</button>
                <button type="button" aria-describedby={`${id}-${index}`} onClick={() => setConfirming(recording)}>Discard</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {failure && <p role="alert" className="listen-local-gap">{failure}</p>}
      <Dialog title="Discard local recording?" open={confirming !== null} onClose={() => setConfirming(null)}>
        {confirming && (
          <div className="listen-panel">
            <p>
              Permanently deletes the recording from {describe(confirming)} from this device. It was never uploaded, so it cannot be recovered.
              Export it first to keep a copy. Other recordings and pending uploads are not touched.
            </p>
            <div className="listen-local-actions">
              <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
              <button type="button" onClick={() => discard(confirming)}>Discard recording</button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}
