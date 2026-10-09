/**
 * First-run welcome: what Sanctum records and who sees it, a microphone check, the workspace and
 * its team, then Start listening. It opens once per person after sign-in and can be skipped at
 * every step; Settings opens it again.
 */
import type { Onboarding } from '@sanctum/contracts';
import { type Dispatch, type FormEvent, type SetStateAction, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { acquireMicrophone, deviceIssue } from '../../lib/capture/microphone.ts';
import type { CaptureView, ListenerState } from '../../lib/capture/view.ts';
import { completeOnboarding, readOnboarding, renameWorkspace, type SignInState } from '../../lib/session.ts';
import { Dialog } from './Dialog.tsx';
import { useInputLevel } from './input-level.ts';
import { InputCheckText, InputPicker } from './InputPicker.tsx';
import { TeamButton } from './SettingsDialog.tsx';

type SignedIn = Extract<SignInState, { status: 'signed_in' }>;

const TITLES = ['What Sanctum records', 'Check your microphone', 'Your workspace', 'Ready to listen'] as const;
const LAST = TITLES.length - 1;

/**
 * The person's welcome state, null until the server answers it, and `reopen` for Settings (null without that state).
 * The first answer showing it unfinished opens `welcome`, unless another overlay (a sign-in notice) is already open.
 */
export function useOnboarding<O>(signIn: SignInState, setOverlay: Dispatch<SetStateAction<O | null>>, welcome: NoInfer<O>) {
  const principal = signIn.status === 'signed_in' ? signIn.access.principal.id : null;
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  useEffect(() => {
    setOnboarding(null);
    if (principal === null) return;
    let current = true;
    void readOnboarding().then(read => {
      if (!current) return;
      setOnboarding(read);
      if (read?.completed === false) setOverlay(open => open ?? welcome);
    });
    return () => void (current = false);
  }, [principal, setOverlay, welcome]);
  return { onboarding, setOnboarding, reopen: onboarding && (() => setOverlay(welcome)) };
}

function WhatItRecords() {
  const rows = [
    ['Records', 'Audio, only while this tab is open and listening'],
    ['Keeps', 'Transcripts, a private recording of each meeting, notes and memory'],
    ['Who sees it', 'Only you; anyone else, including workspace owners, admins and agents, sees a meeting only when it is shared with them.'],
    ['Captions', 'Shown by your browser’s speech service (in Chrome, Google’s), never saved'],
  ] as const;
  return (
    <>
      <p>Sanctum listens to your meetings from this tab and stays silent until you speak to it.</p>
      <dl className="listen-settings">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The microphone check opens its own streams, so it runs only while capture holds none. */
const IDLE: ReadonlyArray<ListenerState> = ['stopped', 'paused'];

/** The browser's answer to this step's own permission request. */
type Access = 'idle' | 'asking' | 'denied' | 'failed';

const ACCESS: Record<Access, string> = {
  idle: 'Your browser asks for permission once.',
  asking: 'Waiting for your permission.',
  denied: 'Microphone permission was denied. Allow it in your browser’s site settings, then try again.',
  failed: 'No microphone could be opened. Connect one, then try again.',
};

/** `value` 0..1. */
function Meter({ value }: { value: number }) {
  return (
    <div className="listen-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ transform: `scaleX(${value})` }} />
    </div>
  );
}

/** One preview stream of the chosen input: its peak on a -60..0 dBFS scale, so speech fills the bar instead of a sliver of it, and the picker's sound check. */
function LevelCheck({ deviceId }: { deviceId: string | null }) {
  const input = useInputLevel(deviceId);
  return (
    <>
      <Meter value={input.level > 0 ? Math.max(0, 1 + Math.log10(input.level) / 3) : 0} />
      <InputCheckText input={input} />
    </>
  );
}

/** Only the browser's prompt: the stream closes at once, and the level opens its own once allowed. */
function AskForMicrophone({ onAllowed }: { onAllowed: () => void }) {
  const [access, setAccess] = useState<Access>('idle');
  const ask = () => {
    setAccess('asking');
    acquireMicrophone(navigator.mediaDevices).then(stream => {
      stream.getTracks().forEach(track => track.stop());
      onAllowed();
    }, (error: unknown) => setAccess(deviceIssue(error) === 'permission_denied' ? 'denied' : 'failed'));
  };
  return (
    <>
      <div className="listen-onboarding-mic"><Meter value={0} /></div>
      <div className="listen-onboarding-check">
        <p role="status" data-access={access}>{ACCESS[access]}</p>
        {access !== 'asking' && <button type="button" data-primary onClick={ask}>{access === 'idle' ? 'Allow microphone' : 'Try again'}</button>}
      </div>
    </>
  );
}

/** The picker with a live level while capture is idle; a running capture already uses the input, so the step says so instead. */
function ChosenInput({ engine }: { engine: CaptureView }) {
  const { inputId, listener } = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  return (
    <div className="listen-onboarding-mic">
      <InputPicker engine={engine} />
      {IDLE.includes(listener) ? <LevelCheck deviceId={inputId} /> : <p>Sanctum is listening with this microphone now. Pause to check it here.</p>}
    </div>
  );
}

/** Permission first, then the picker with a live level; the preview streams are never recorded or sent. */
function MicrophoneCheck({ engine }: { engine: CaptureView }) {
  const permission = useSyncExternalStore(engine.subscribe, () => engine.getSnapshot().permission);
  const [allowed, setAllowed] = useState(false);
  return (
    <>
      <p>Speak, and the bar moves with your voice. If it stays flat, choose another microphone. This check records nothing.</p>
      {allowed || permission === 'granted' ? <ChosenInput engine={engine} /> : <AskForMicrophone onAllowed={() => setAllowed(true)} />}
    </>
  );
}

/** Team for this server, or nothing where it holds none; the owner of an unlinked hosted workspace sets it up first. */
function InviteTeammates({ signIn, onSignInChange }: { signIn: SignedIn; onSignInChange: () => void }) {
  if (!signIn.team && !signIn.workosTeam) return null;
  return (
    <div className="listen-onboarding-check">
      <p>Invite the people you meet with.</p>
      <TeamButton signIn={signIn} onSignInChange={onSignInChange} label={signIn.workosTeam === 'setup' ? 'Set up team' : 'Invite teammates'} />
    </div>
  );
}

interface WorkspaceProps {
  signIn: SignedIn;
  onSignInChange: () => void;
  onboarding: Onboarding;
  /** The step's form, which the name field joins: the Team dialogs hold forms of their own, so they stay outside it. */
  form: string;
}

/** Owners and admins rename the workspace and invite through this server's Team; everyone else reads the name. */
function WorkspaceSetup({ signIn, onSignInChange, onboarding, form }: WorkspaceProps) {
  if (!signIn.access.scopes.includes('workspace:admin')) {
    return <p>You are in <strong>{onboarding.workspace_name}</strong>. Its owners and admins rename it and invite people.</p>;
  }
  return (
    <>
      <label className="listen-onboarding-field">
        <span>Workspace name</span>
        <input name="workspace" form={form} defaultValue={onboarding.workspace_name} required maxLength={200} pattern=".*\S.*" autoComplete="organization" />
      </label>
      <InviteTeammates signIn={signIn} onSignInChange={onSignInChange} />
    </>
  );
}

function ReadyToListen() {
  return (
    <>
      <p>Keep this tab open while Sanctum listens. Closing the tab, or the computer going to sleep, stops listening.</p>
      <p>Pause, at the bottom of the screen, stops the microphone at any time. Settings opens this welcome again.</p>
    </>
  );
}

/** Back from the second step on; the last step's action starts listening, or only closes while capture already runs. */
function StepActions({ step, busy, form, idle, onBack }: { step: number; busy: boolean; form: string; idle: boolean; onBack: () => void }) {
  const label = step < LAST ? 'Next' : idle ? 'Start listening' : 'Done';
  return (
    <div className="listen-end-actions">
      {step > 0 && <button type="button" onClick={onBack}>Back</button>}
      <button type="submit" form={form} data-primary disabled={busy}>{label}</button>
    </div>
  );
}

interface StepsProps {
  /** Closes the welcome as done; `start` also starts listening. */
  onFinish: (start: boolean) => void;
  engine: CaptureView;
  signIn: SignedIn;
  onSignInChange: () => void;
  onboarding: Onboarding;
  onRenamed: (onboarding: Onboarding) => void;
}

/** The steps live inside the dialog, so every opening starts at the first one. */
function Steps({ onFinish, engine, signIn, onSignInChange, onboarding, onRenamed }: StepsProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useId();
  const idle = IDLE.includes(useSyncExternalStore(engine.subscribe, () => engine.getSnapshot().listener));
  // Each step's heading takes focus, also the first after the dialog opens, so a screen reader reads where the person is.
  useEffect(() => {
    const frame = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [step]);
  const go = (next: number) => {
    setFailure(null);
    setStep(next);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step === LAST) return onFinish(idle);
    const name = new FormData(event.currentTarget).get('workspace');
    if (typeof name !== 'string' || name.trim() === onboarding.workspace_name) return go(step + 1);
    setBusy(true);
    renameWorkspace(name)
      .then(renamed => (onRenamed(renamed), go(step + 1)), (error: Error) => setFailure(`The name was not saved: ${error.message}`))
      .finally(() => setBusy(false));
  };
  const body = [
    <WhatItRecords />,
    <MicrophoneCheck engine={engine} />,
    <WorkspaceSetup signIn={signIn} onSignInChange={onSignInChange} onboarding={onboarding} form={form} />,
    <ReadyToListen />,
  ][step];
  return (
    <div className="listen-panel listen-onboarding">
      <p className="listen-onboarding-step">Step {step + 1} of {TITLES.length}</p>
      <h3 ref={heading} tabIndex={-1}>{TITLES[step]}</h3>
      <form id={form} onSubmit={submit} />
      {body}
      {failure && <p role="alert" className="listen-local-gap">{failure}</p>}
      <StepActions step={step} busy={busy} form={form} idle={idle} onBack={() => go(step - 1)} />
    </div>
  );
}

interface WelcomeProps {
  open: boolean;
  onClose: () => void;
  engine: CaptureView;
  signIn: SignInState;
  onSignInChange: () => void;
  /** Null until the server answers, and then no welcome. */
  onboarding: Onboarding | null;
  onChange: (onboarding: Onboarding) => void;
  /** Why Start listening did not start capture; null clears it. */
  onFailure: (message: string | null) => void;
}

/** Skip, Escape and the last step all close it and count as done; Start listening also starts or resumes capture. */
export function Welcome({ open, onClose, engine, signIn, onSignInChange, onboarding, onChange, onFailure }: WelcomeProps) {
  if (signIn.status !== 'signed_in' || onboarding === null) return null;
  const finish = (start: boolean): void => {
    onClose();
    if (!onboarding.completed) completeOnboarding().then(onChange, () => {});
    if (!start) return;
    onFailure(null);
    (engine.getSnapshot().listener === 'paused' ? engine.resume() : engine.start()).catch((error: unknown) => onFailure(error instanceof Error ? error.message : String(error)));
  };
  return (
    <Dialog title="Welcome to Sanctum" closeLabel="Skip" open={open} onClose={() => finish(false)}>
      <Steps onFinish={finish} engine={engine} signIn={signIn} onSignInChange={onSignInChange} onboarding={onboarding} onRenamed={onChange} />
    </Dialog>
  );
}
