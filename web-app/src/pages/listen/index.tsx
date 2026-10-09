import type { Meeting } from '@sanctum/sdk';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { storedListenerId } from '../../lib/capture/stored-listener.ts';
import type { ArchiveState, CaptureIssue, CaptureSnapshot, CaptureView, ListenerState } from '../../lib/capture/view.ts';
import { endMeeting, readSignIn, sessionClient, SIGN_IN_URL, takeSignInNotice, type SignInState } from '../../lib/session.ts';
import { AgentsDialog } from './AgentsDialog.tsx';
import { Dialog } from './Dialog.tsx';
import { browserRecognition, type CaptionState, startCaptions } from './captions.ts';
import { getCaptureEngine, subscribeActions, subscribeTranscript } from './engine.ts';
import { deviceName, InputPicker } from './InputPicker.tsx';
import { clearCaptions, showCaption, startActionFeed, startTranscriptRail } from './rails.ts';
import { ReviewDialog } from './ReviewDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { startWaveform } from './waveform.ts';
import './listen.css';

type Overlay = 'review' | 'agents' | 'settings';

const client = sessionClient();

/** Read once per page load: `/auth/callback` lands here with `?signin=<code>` when sign-in ends without a session. */
const notice = takeSignInNotice(window.location, window.history);

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
  signed_out: 'You are not signed in.',
  lease_lost: 'Another listener took over this room.',
  listener_removed: 'This device was removed, so listening stopped. Resume registers it again.',
  transcription_unavailable: 'Live transcription is unavailable. Audio is still being saved.',
  transcription_behind: 'Live transcription is behind. Audio is still being saved and is transcribed later.',
  silent_input: 'The microphone is sending no sound.',
  input_unavailable: 'The chosen microphone is not connected, so Sanctum uses the default microphone.',
};

const ARCHIVE: Record<ArchiveState, string> = {
  capturing: 'recording',
  buffered_locally: 'buffered on this device',
  uploading: 'uploading',
  saved_remotely: 'saved',
  interrupted: 'recording interrupted',
  missing: 'recording missing',
};

const count = (chunks: number, label: string): string => (chunks > 0 ? ` · ${chunks} ${label}` : '');

function health(snapshot: CaptureSnapshot): string {
  const archive = snapshot.archive ? ARCHIVE[snapshot.archive] : 'not recording';
  const pending = count(snapshot.bufferedChunks, 'chunks pending');
  const stranded = count(snapshot.strandedChunks, 'chunks of removed listeners kept on this device, not uploadable');
  const refused = count(snapshot.refusedChunks, 'chunks refused by the server kept on this device, not uploadable');
  return `Silent · ${archive}${pending}${stranded}${refused}`;
}

/** A silent input is named, so the person knows which one to replace. */
function issueText({ issue, inputLabel }: CaptureSnapshot): string | null {
  if (issue === null) return null;
  return issue === 'silent_input' && inputLabel ? `${deviceName(inputLabel)} is sending no sound.` : ISSUE[issue];
}

/** `helper`: the quiet line shown when nothing is wrong. */
function statusMessage(snapshot: CaptureSnapshot, failure: string | null, helper: string): { text: string; warning: boolean } {
  const problem = failure ?? issueText(snapshot);
  return problem ? { text: problem, warning: true } : { text: helper, warning: false };
}

/** A silent or missing input gets the picker right under the warning (and, when silent, one line of help); otherwise `children` show. */
function InputHelp({ engine, issue, children }: { engine: CaptureView; issue: CaptureIssue | null; children: ReactNode }) {
  if (issue !== 'silent_input' && issue !== 'input_unavailable') return children;
  return (
    <>
      {issue === 'silent_input' && <p className="listen-helper listen-input-help">A Mac with its lid closed turns off its built-in microphone. Choose another input:</p>}
      <InputPicker engine={engine} />
    </>
  );
}

const CAPTURING: ReadonlyArray<ListenerState> = ['listening', 'degraded', 'reconnecting'];

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

/** The listener's open meeting, named by the stream's `action_update`: its title, else its start time; no line without one. */
function MeetingLine() {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  useEffect(() => {
    // The meeting read or being read; a failed read clears it so the next update for that meeting reads again.
    let shown: string | null = null;
    return subscribeActions(({ meeting_id }) => {
      if (meeting_id === shown) return;
      shown = meeting_id;
      setMeeting(null);
      // A failed read shows no line rather than a false one; a stale read never replaces a newer meeting.
      if (meeting_id !== null) client.meetings.getMeeting({ meeting_id }).then(read => read.id === shown && setMeeting(read), () => { shown = shown === meeting_id ? null : shown; });
    });
  }, []);
  if (meeting === null) return null;
  const started = new Date(meeting.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return <p className="listen-meeting">{meeting.title ?? <>Meeting since <time dateTime={meeting.started_at}>{started}</time></>}</p>;
}

const OPEN: ReadonlyArray<Meeting['state']> = ['provisional', 'active'];

/** The newest open meeting this browser's listener captures, for a page that loaded before any stream update; none before the browser has registered a listener. */
async function readOpenMeeting(): Promise<string | null> {
  const listener = storedListenerId();
  if (listener === null) return null;
  const pages = await Promise.all(OPEN.map(state => client.meetings.listMeetings({ state, listener, limit: 1 })));
  const newest = pages.flatMap(page => page.meetings).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  return newest?.id ?? null;
}

/**
 * The listener's open meeting that End meeting closes: read once on load, so a reload while paused still
 * shows it, then named by the stream's `action_update`. A pause ends the stream with an update naming
 * no meeting, so a null update keeps the meeting while the server still reports it open. The returned
 * function forgets it once closed.
 */
function useOpenMeeting(): [string | null, () => void] {
  const shown = useRef<string | null>(null);
  const [meeting, setMeeting] = useState<string | null>(null);
  const show = useCallback((id: string | null) => {
    shown.current = id;
    setMeeting(id);
  }, []);
  useEffect(() => {
    // A stream update before the read returns is newer than the read.
    let current = true;
    readOpenMeeting().then(id => current && id !== null && show(id), () => {});
    const stop = subscribeActions(({ meeting_id }) => {
      current = false;
      const previous = shown.current;
      if (meeting_id !== null || previous === null) show(meeting_id);
      // A failed read keeps the control: closing is idempotent. A newer update or a close wins over this read.
      else client.meetings.getMeeting({ meeting_id: previous }).then(read => shown.current === previous && !OPEN.includes(read.state) && show(null), () => {});
    });
    return () => {
      current = false;
      stop();
    };
  }, [show]);
  return [meeting, () => show(null)];
}

/**
 * End meeting: capture stops first, and the end request carries the last sample this page captured before the pause (also
 * when it is already paused), so finals still in flight or reconciled later join the closed meeting and never open a new one.
 * Without any capture on this page (a reload while paused) it carries no sample and the server fences what the meeting used. `helper` says so until capture starts again, else names the listener state.
 */
function useEndMeeting(engine: CaptureView, listener: ListenerState, onFailure: (message: string | null) => void) {
  const [meeting, forget] = useOpenMeeting();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (CAPTURING.includes(listener)) setEnded(false);
  }, [listener]);
  const end = (meeting_id: string): void => {
    onFailure(null);
    engine.end().then(captured => endMeeting(meeting_id, captured)).then(() => {
      forget();
      setEnded(true);
    }, (error: unknown) => onFailure(`Meeting not ended: ${error instanceof Error ? error.message : String(error)}`));
  };
  return { meeting, helper: ended ? 'Meeting ended. Its notes are being prepared in Review.' : HELPER[listener], end };
}

/** The End meeting control and its one confirmation; nothing while no meeting is open. Keyed by meeting, so a confirmation never carries over to the next one. */
function EndMeeting({ meeting, onEnd }: { meeting: string | null; onEnd: (meeting_id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  if (meeting === null) return null;
  return (
    <>
      <button type="button" className="listen-end" onClick={() => setConfirming(true)}>End meeting</button>
      <Dialog title="End this meeting?" open={confirming} onClose={() => setConfirming(false)}>
        <div className="listen-panel">
          <p>Listening stops, and Sanctum prepares the meeting's notes, memory and recording. Resume starts a new meeting.</p>
          <div className="listen-end-actions">
            <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" data-primary onClick={() => (setConfirming(false), onEnd(meeting))}>End meeting</button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

interface FooterProps {
  engine: CaptureView;
  snapshot: CaptureSnapshot;
  onOpen: (overlay: Overlay) => void;
  onFailure: (message: string | null) => void;
  /** Controls shown right after Pause or Resume. */
  children: ReactNode;
}

function Footer({ engine, snapshot, onOpen, onFailure, children }: FooterProps) {
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
        {children}
        <button type="button" onClick={() => onOpen('review')}>Review</button>
        <button type="button" onClick={() => onOpen('agents')}>Agents</button>
        {document.fullscreenEnabled && <FullscreenButton />}
        <button type="button" onClick={() => onOpen('settings')}>Settings</button>
      </nav>
    </footer>
  );
}

/** The browser-captions line under the status while capture runs: whose speech service runs them, or why none can. */
const CAPTION_NOTE: Record<Exclude<CaptionState, 'off'>, string> = {
  on: "Live captions use your browser's speech service (in Chrome, Google's).",
  unavailable: 'Word-by-word captions are not available in this browser. Lines appear after each phrase.',
  language: 'Word-by-word captions are not available for this language. Lines appear after each phrase.',
};

function CaptionNote({ state, capturing }: { state: CaptionState; capturing: boolean }) {
  if (!capturing || state === 'off') return null;
  return <p className="listen-helper listen-note">{CAPTION_NOTE[state]}</p>;
}

interface RailsProps {
  live: boolean;
  /** Capture runs (also while degraded or reconnecting), so browser captions run too. */
  capturing: boolean;
  onCaptions: (state: CaptionState) => void;
}

/** Side live updates: what the room said on the left, agent work on the right. */
function Rails({ live, capturing, onCaptions }: RailsProps) {
  const lines = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => startTranscriptRail(lines.current!, subscribeTranscript), []);
  useEffect(() => startActionFeed(feed.current!, subscribeActions), []);
  useEffect(() => {
    const Recognition = browserRecognition();
    if (!capturing || Recognition === undefined) return;
    const rail = { show: (text: string, final: boolean) => showCaption(lines.current!, text, final), clear: () => clearCaptions(lines.current!) };
    return startCaptions(Recognition, subscribeTranscript, rail, onCaptions);
  }, [capturing, onCaptions]);
  return (
    <div className="listen-rails">
      <section className="listen-tlog" aria-label="Live transcript" data-live={live}>
        <p className="eyebrow"><i className="dot" />Listening</p>
        <div ref={lines} className="tlines" />
      </section>
      <section className="listen-feed" aria-label="Agent work">
        <p className="eyebrow"><i className="dot" />Agent work</p>
        <div ref={feed} className="frows" />
      </section>
    </div>
  );
}

/** Fullscreen listening view: waveform stage, sparse header, side live updates, quiet footer controls, secondary overlays. */
export function ListenPage() {
  const engine = getCaptureEngine();
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(notice ? 'settings' : null);
  const [signIn, setSignIn] = useState<SignInState>({ status: 'checking' });
  const refreshSignIn = useCallback(() => void readSignIn(client).then(setSignIn), []);
  // A capture issue may mean the session ended, so each new issue reads the session again.
  useEffect(refreshSignIn, [refreshSignIn, snapshot.issue]);
  const [failure, setFailure] = useState<string | null>(null);
  const [captions, setCaptions] = useState<CaptionState>('off');
  const capturing = CAPTURING.includes(snapshot.listener);
  useEffect(() => startWaveform(canvas.current!, engine.levels, () => engine.getSnapshot().listener), [engine]);
  const { meeting, helper, end } = useEndMeeting(engine, snapshot.listener, setFailure);
  const message = statusMessage(snapshot, failure, helper);
  const close = (): void => setOverlay(null);

  return (
    <main aria-label="Sanctum" className="listen">
      <canvas ref={canvas} className="listen-wave" aria-hidden="true" />
      <header className="listen-header">
        <div className="listen-brand">
          <span className="listen-wordmark">✦ SANCTUM</span>
          <Clock />
        </div>
        <MeetingLine />
      </header>
      <section className="listen-status" aria-live="polite">
        <p className="listen-state">{snapshot.listener}</p>
        {signIn.status === 'signed_out'
          ? <a className="listen-helper" href={SIGN_IN_URL}>Sign in to listen</a>
          : <p className="listen-helper" data-warning={message.warning}>{message.text}</p>}
        <InputHelp engine={engine} issue={snapshot.issue}>
          <CaptionNote state={captions} capturing={capturing} />
        </InputHelp>
      </section>
      <Rails live={snapshot.listener === 'listening'} capturing={capturing} onCaptions={setCaptions} />
      <Footer engine={engine} snapshot={snapshot} onOpen={setOverlay} onFailure={setFailure}>
        <EndMeeting key={String(meeting)} meeting={meeting} onEnd={end} />
      </Footer>
      <ReviewDialog client={client} open={overlay === 'review'} onClose={close} />
      <AgentsDialog client={client} open={overlay === 'agents'} onClose={close} />
      <SettingsDialog open={overlay === 'settings'} onClose={close} permission={snapshot.permission} engine={engine} client={client} signIn={signIn} notice={notice} onSignInChange={refreshSignIn} />
    </main>
  );
}
