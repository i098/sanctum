/**
 * `/pair`: a signed-in person types the code a device shows (RFC 8628 user code), sees what the
 * device is, and approves or denies it. `?code=` fills the code, so a printed or shown link works.
 */
import type { DeviceCapabilities } from '@sanctum/contracts';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { codeDigits, formatCode, makeDevicesClient, type PendingDevice, type Refusal } from '../../lib/devices.ts';
import { readSignIn, sessionClient, type SignInState } from '../../lib/session.ts';

const devices = makeDevicesClient();

const button = 'inline-flex min-h-9 items-center justify-center rounded-lg px-4 font-medium disabled:opacity-60';
const primary = `${button} bg-(--btn-primary) text-white not-disabled:hover:bg-(--btn-primary-hover)`;
const secondary = `${button} bg-(--btn-secondary) text-ink not-disabled:hover:bg-(--btn-secondary-hover)`;

const REFUSED: Record<Exclude<Refusal, 'signed_out'>, string> = {
  not_found: 'No device is waiting for this code. Check the code on the device.',
  locked: 'Too many wrong codes. Wait 10 minutes, then try again.',
  failed: 'Sanctum did not answer. Try again.',
};

const LIGHT: Record<DeviceCapabilities['light'], string | null> = { none: null, mono: 'Light', pwm: 'Dimmable light', rgb: 'Color light' };

type Step = { kind: 'code' } | { kind: 'found'; code: string; device: PendingDevice } | { kind: 'done'; paired: boolean };

function Card({ title, error = null, children }: { title: string; error?: string | null; children: ReactNode }) {
  return (
    <main className="flex h-full items-center justify-center overflow-y-auto p-6">
      <section className="w-full max-w-sm rounded-lg border border-divider bg-overlay p-7 text-sm">
        <h1 className="mb-5 text-base font-medium">{title}</h1>
        {children}
        {error && <p role="alert" className="mt-4 text-warning">{error}</p>}
      </section>
    </main>
  );
}

/** Before the session reads as signed in: sign-in comes back to `/pair` with the code kept. */
function SignInGate({ status, code }: { status: SignInState['status']; code: string }) {
  const digits = codeDigits(code);
  const back = digits === null ? '/pair' : `/pair?code=${digits}`;
  const body: Partial<Record<SignInState['status'], ReactNode>> = {
    checking: <p className="text-ink-secondary">Checking sign-in</p>,
    signed_out: <a className={primary} href={`/auth/login?${new URLSearchParams({ return_to: back })}`}>Sign in to pair</a>,
  };
  return <Card title="Pair a device">{body[status] ?? <p>Sign-in is not available on this server now.</p>}</Card>;
}

function CodeForm({ code, busy, onChange, onSubmit }: { code: string; busy: boolean; onChange: (code: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <label className="flex flex-col gap-1">
        Code on the device
        <input
          className="w-full rounded border border-divider bg-surface px-3 py-2 font-mono text-lg tracking-widest text-ink tabular-nums outline-none focus-visible:border-accent"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="1234-5678"
          value={code}
          onChange={event => onChange(formatCode(event.target.value))}
        />
      </label>
      <button className={primary} type="submit" disabled={busy}>Continue</button>
    </form>
  );
}

function Found({ device, code, busy, onAnswer }: { device: PendingDevice; code: string; busy: boolean; onAnswer: (approve: boolean) => void }) {
  return (
    <>
      <p className="text-base text-ink">{device.name}</p>
      <ul aria-label="What it has" className="mt-1 mb-4 flex flex-wrap gap-x-3 text-ink-secondary">
        {[device.capabilities.mic && 'Microphone', device.capabilities.screen && 'Screen', LIGHT[device.capabilities.light], device.capabilities.speaker && 'Speaker']
          .filter(part => typeof part === 'string')
          .map(part => <li key={part}>{part}</li>)}
      </ul>
      <p>Approve only if your device shows the code {formatCode(code)}.</p>
      <p className="mb-5">It records the room while its light is steady or its screen shows listening.</p>
      <div className="flex gap-3">
        <button className={primary} type="button" disabled={busy} onClick={() => onAnswer(true)}>Approve</button>
        <button className={secondary} type="button" disabled={busy} onClick={() => onAnswer(false)}>Deny</button>
      </div>
    </>
  );
}

/** The answer was saved; the device picks up its credential on its next poll. */
function Done({ paired }: { paired: boolean }) {
  return <Card title={paired ? 'Paired' : 'Not paired'}><a className="text-ink-secondary underline" href="/">Open Sanctum</a></Card>;
}

export function PairPage() {
  const [signIn, setSignIn] = useState<SignInState['status']>('checking');
  const [code, setCode] = useState(() => formatCode(new URLSearchParams(location.search).get('code') ?? ''));
  const [step, setStep] = useState<Step>({ kind: 'code' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void readSignIn(sessionClient()).then(state => setSignIn(state.status)), []);

  // Every answer here is an object, so a string is a refusal.
  const settle = <A extends object>(answer: A | Refusal, next: (value: A) => void) => {
    setBusy(false);
    if (typeof answer !== 'string') {
      setError(null);
      return next(answer);
    }
    if (answer === 'signed_out') return setSignIn('signed_out');
    // An expired or used code cannot be approved: back to the code, under the reason.
    setStep({ kind: 'code' });
    setError(REFUSED[answer]);
  };

  const lookUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const digits = codeDigits(code);
    if (digits === null) return setError('Type the 8 digits the device shows.');
    setBusy(true);
    void devices.pending(digits).then(answer => settle(answer, device => setStep({ kind: 'found', code: digits, device })));
  };

  const answer = (found: { code: string }, approve: boolean) => {
    setBusy(true);
    void devices.approve(found.code, approve).then(result => settle(result, () => setStep({ kind: 'done', paired: approve })));
  };

  if (signIn !== 'signed_in') return <SignInGate status={signIn} code={code} />;
  if (step.kind === 'done') return <Done paired={step.paired} />;
  return (
    <Card title="Pair a device" error={error}>
      {step.kind === 'found'
        ? <Found device={step.device} code={step.code} busy={busy} onAnswer={approve => answer(step, approve)} />
        : <CodeForm code={code} busy={busy} onChange={setCode} onSubmit={lookUp} />}
    </Card>
  );
}
