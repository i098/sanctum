import { createClient } from '@sanctum/sdk';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ArchiveState, CaptureIssue, CaptureSnapshot, CaptureView, ListenerState } from '../../lib/capture/view.ts';
import { AgentsDialog } from './AgentsDialog.tsx';
import { getCaptureEngine } from './engine.ts';
import { ReviewDialog } from './ReviewDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { startWaveform } from './waveform.ts';
import './listen.css';

type Overlay = 'review' | 'agents' | 'settings';

/** Same-origin v1 client: calls carry the browser session like every other request from this page. */
const client = createClient({ baseUrl: window.location.origin });

const HELPER: Record<ListenerState, string> = {
  stopped: 'Choose Listen to start the microphone.',
  starting: 'Starting the microphone.',
  listening: 'Speak to Sanctum when you need it.',
  reconnecting: 'Reconnecting. Audio stays on this device until the server is back.',
  paused: 'Paused. The microphone is not being captured.',
  degraded: 'Listening with a problem.',
};

const ISSUE: Record<CaptureIssue, string> = {
  insecure_context: 'The microphone needs a secure (HTTPS) page.',
  permission_denied: 'Microphone permission was denied. Allow it in browser settings.',
  no_input: 'No microphone input is arriving.',
  input_lost: 'The microphone was disconnected.',
  hardware_error: 'The microphone reported a hardware error.',
  unsupported_constraints: 'This microphone does not support the required audio format.',
  storage_full: 'Device storage is full, so audio cannot be buffered.',
  storage_unavailable: 'Device storage is unavailable, so audio cannot be buffered.',
  socket_unavailable: 'The server connection is unavailable.',
  lease_lost: 'Another listener took over this room.',
};

const ARCHIVE: Record<ArchiveState, string> = {
  capturing: 'recording',
  buffered_locally: 'buffered on this device',
  uploading: 'uploading',
  saved_remotely: 'saved',
  interrupted: 'recording interrupted',
  missing: 'recording missing',
};

function health(snapshot: CaptureSnapshot): string {
  const archive = snapshot.archive ? ARCHIVE[snapshot.archive] : 'not recording';
  const pending = snapshot.bufferedChunks > 0 ? ` · ${snapshot.bufferedChunks} chunks pending` : '';
  return `Silent · ${archive}${pending}`;
}

function statusMessage(snapshot: CaptureSnapshot, failure: string | null): { text: string; warning: boolean } {
  const problem = failure ?? (snapshot.issue && ISSUE[snapshot.issue]);
  return problem ? { text: problem, warning: true } : { text: HELPER[snapshot.listener], warning: false };
}

function toggle(engine: CaptureView, listener: ListenerState): { label: string; run: () => Promise<void> } {
  if (listener === 'paused') return { label: 'Resume', run: () => engine.resume() };
  if (listener === 'stopped') return { label: 'Listen', run: () => engine.start() };
  return { label: 'Pause', run: () => engine.pause() };
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time className="listen-clock" dateTime={now.toISOString()}>
      <span>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      <span>{now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
    </time>
  );
}

function FullscreenButton() {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = (): void => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  return (
    <button type="button" aria-pressed={fullscreen} onClick={() => void (fullscreen ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>
      Fullscreen
    </button>
  );
}

interface FooterProps {
  engine: CaptureView;
  snapshot: CaptureSnapshot;
  onOpen: (overlay: Overlay) => void;
  onFailure: (message: string | null) => void;
}

function Footer({ engine, snapshot, onOpen, onFailure }: FooterProps) {
  const control = toggle(engine, snapshot.listener);
  const run = (): void => {
    onFailure(null);
    control.run().catch((error: unknown) => onFailure(error instanceof Error ? error.message : String(error)));
  };
  const warning = snapshot.issue !== null || snapshot.listener === 'degraded';
  return (
    <footer className="listen-footer">
      <p className="listen-health" data-tone={warning ? 'warning' : snapshot.listener}>{health(snapshot)}</p>
      <nav aria-label="Listening controls" className="listen-controls">
        <button type="button" onClick={run} disabled={snapshot.listener === 'starting'}>{control.label}</button>
        <button type="button" onClick={() => onOpen('review')}>Review</button>
        <button type="button" onClick={() => onOpen('agents')}>Agents</button>
        {document.fullscreenEnabled && <FullscreenButton />}
        <button type="button" onClick={() => onOpen('settings')}>Settings</button>
      </nav>
    </footer>
  );
}

/** Fullscreen listening view: waveform stage, sparse header, quiet footer controls, secondary overlays. */
export function ListenPage() {
  const engine = getCaptureEngine();
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => startWaveform(canvas.current!, engine.levels, () => engine.getSnapshot().listener), [engine]);
  const message = statusMessage(snapshot, failure);
  const close = (): void => setOverlay(null);

  return (
    <main aria-label="Sanctum" className="listen">
      <canvas ref={canvas} className="listen-wave" aria-hidden="true" />
      <header className="listen-header">
        <div className="listen-brand">
          <span className="listen-wordmark">✦ SANCTUM</span>
          <Clock />
        </div>
        <p className="listen-meeting">Meeting details unavailable</p>
      </header>
      <section className="listen-status" aria-live="polite">
        <p className="listen-state">{snapshot.listener}</p>
        <p className="listen-helper" data-warning={message.warning}>{message.text}</p>
      </section>
      <Footer engine={engine} snapshot={snapshot} onOpen={setOverlay} onFailure={setFailure} />
      <ReviewDialog client={client} open={overlay === 'review'} onClose={close} />
      <AgentsDialog client={client} open={overlay === 'agents'} onClose={close} />
      <SettingsDialog open={overlay === 'settings'} onClose={close} permission={snapshot.permission} />
    </main>
  );
}
