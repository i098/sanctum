import type { SanctumClient } from '@sanctum/sdk';
import { lazy, Suspense, useState, type FormEvent, type ReactNode } from 'react';
import type { CaptureView, PermissionState } from '../../lib/capture/view.ts';
import { accountLabel, connectSignIn, SIGN_IN_URL, signOut, type SignInNotice, type SignInState } from '../../lib/session.ts';
import { Dialog } from './Dialog.tsx';
import { InputPicker } from './InputPicker.tsx';
import { Integrations } from './Integrations.tsx';
import { LocalRecordings } from './LocalRecordings.tsx';
import { WorkspaceDeletion } from './WorkspaceDeletion.tsx';

// The WorkOS widgets load only when an owner or admin first opens Team (Dialog renders its children only while open).
const TeamWidgets = lazy(() => import('./WorkosTeam.tsx').then(module => ({ default: module.TeamWidgets })));
const SetUpTeam = lazy(() => import('./WorkosTeam.tsx').then(module => ({ default: module.SetUpTeam })));
// The embedded issuer's client loads only when Settings opens on a self-hosted install with it.
const TeamDialog = lazy(() => import('../auth/team.tsx').then(module => ({ default: module.TeamDialog })));
const ProfileDialog = lazy(() => import('../auth/team.tsx').then(module => ({ default: module.ProfileDialog })));

const MICROPHONE: Record<PermissionState, string> = {
  unknown: 'Not requested yet',
  prompt: 'The browser will ask when listening starts',
  pending: 'Waiting for your permission',
  granted: 'Allowed',
  denied: 'Blocked in browser settings',
  unsupported: 'Not supported by this browser',
};

const NOTICE: Record<SignInNotice['code'], string> = {
  not_member: 'You signed in, but this account is not a member of a workspace yet. Give these values to the operator who adds members:',
  failed: 'Sign-in did not finish. Try again.',
  unconfigured: 'Sign-in is not configured on this server.',
};

const SIGN_IN: Record<Exclude<SignInState['status'], 'signed_in'>, string> = {
  checking: 'Checking',
  unconfigured: 'Not configured: no sign-in provider has been selected',
  signed_out: 'Signed out',
  unavailable: 'Unavailable: the session could not be read',
};

const WORKSPACE: Record<SignInState['status'], string> = {
  checking: 'Checking',
  unconfigured: 'Unavailable until sign-in is configured',
  signed_out: 'Unavailable until you sign in',
  unavailable: 'Unavailable until you sign in',
  signed_in: 'Name not shown yet',
};

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  permission: PermissionState;
  engine: CaptureView;
  signIn: SignInState;
  notice: SignInNotice | null;
  onSignInChange: () => void;
  client: SanctumClient;
  /** Reopens the first-run welcome; null (signed out, or no answer from the server) offers no Welcome row. */
  onWelcome: (() => void) | null;
}

/** Self-serve: signs in again, and the server creates the workspace with this user as owner when it still finds no membership. */
function CreateWorkspace() {
  // The browser's own zone may be an alias (such as `UTC`) that the canonical list leaves out.
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = Intl.supportedValuesOf('timeZone');
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // `/?signin=ok` is SIGN_IN_URL's return, so the first signed-in view confirms who signed in.
    const query = new URLSearchParams({ return_to: '/?signin=ok', workspace_name: String(form.get('name')).trim(), timezone: String(form.get('timezone')) });
    // A navigation, not a form submission: the issuer redirect leaves the origin, and the CSP allows only `form-action 'self'`.
    window.location.assign(`/auth/login?${query}`);
  };
  return (
    <form onSubmit={create} className="mt-3 grid gap-3">
      <p>Or create your own workspace:</p>
      <label className="grid gap-1">
        <span className="text-sm text-ink-secondary">Workspace name</span>
        <input name="name" required maxLength={200} pattern=".*\S.*" className="rounded bg-surface px-3 py-2" />
      </label>
      <label className="grid gap-1">
        <span className="text-sm text-ink-secondary">Timezone</span>
        <select name="timezone" defaultValue={current} className="rounded bg-surface px-3 py-2">
          {(zones.includes(current) ? zones : [current, ...zones]).map(zone => <option key={zone}>{zone}</option>)}
        </select>
      </label>
      <div className="flex justify-end">
        <button type="submit" data-primary>Create workspace</button>
      </div>
    </form>
  );
}

function Notice({ notice, selfServe }: { notice: SignInNotice; selfServe: boolean }) {
  return (
    <div role="status" className="listen-signin-notice">
      <p>{NOTICE[notice.code]}</p>
      {notice.code === 'not_member' && (
        <dl>
          <dt>Issuer</dt>
          <dd>{notice.issuer}</dd>
          <dt>Subject</dt>
          <dd>{notice.subject}</dd>
        </dl>
      )}
      {notice.code === 'not_member' && selfServe && <CreateWorkspace />}
    </div>
  );
}

type Principal = Extract<SignInState, { status: 'signed_in' }>['access']['principal'];

/** Initials stand in for an avatar: no issuer sends a picture claim, and the CSP loads no remote images. */
function Account({ principal, role }: { principal: Principal; role: string }) {
  const { label, beneath } = accountLabel(principal);
  return (
    <span className="listen-account">
      <span className="listen-avatar" aria-hidden="true">
        {label.split('@')[0]!.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]!.toUpperCase()).join('')}
      </span>
      <span className="listen-account-text">
        <span className="listen-account-name">
          {label} <span className="listen-role">{role}</span>
        </span>
        {beneath && <span className="listen-account-email">{beneath}</span>}
      </span>
    </span>
  );
}

/**
 * Sign out shows only with a configured issuer: without one, the session is an operator-seeded row,
 * and revoking it would leave no way back in.
 */
function SignedIn({ signIn, onSignInChange }: { signIn: Extract<SignInState, { status: 'signed_in' }>; onSignInChange: () => void }) {
  const [failure, setFailure] = useState<string | null>(null);
  const run = (action: () => Promise<void>, failed: string) => {
    setFailure(null);
    action().then(onSignInChange, () => setFailure(failed));
  };
  return (
    <>
      <Account principal={signIn.access.principal} role={signIn.access.role} />
      {signIn.issuer && (
        <span className="listen-signin-actions">
          <button type="button" onClick={() => run(connectSignIn, 'Connect sign-in could not start. Try again.')}>Connect sign-in</button>
          <button type="button" onClick={() => run(signOut, 'Sign out did not finish; you are still signed in.')}>Sign out</button>
          {failure && <span role="alert" className="listen-local-gap">{failure}</span>}
        </span>
      )}
    </>
  );
}

function SignInRow({ signIn, onSignInChange }: { signIn: SignInState; onSignInChange: () => void }) {
  if (signIn.status === 'signed_in') return <SignedIn signIn={signIn} onSignInChange={onSignInChange} />;
  return (
    <>
      <span>{SIGN_IN[signIn.status]}</span>
      {signIn.status === 'signed_out' && <span className="listen-signin-actions"><a href={SIGN_IN_URL} data-primary>Sign in</a></span>}
    </>
  );
}

type Row = readonly [string, ReactNode];

/** Text plus one action, laid out like the sign-in row. */
function WithAction({ text, label, onClick }: { text: string; label: string; onClick: () => void }) {
  return (
    <>
      <span>{text}</span>
      <span className="listen-signin-actions"><button type="button" onClick={onClick}>{label}</button></span>
    </>
  );
}

/** The WorkOS widgets, or Set up team for the owner of a hosted workspace created before WorkOS. */
function WorkosTeamDialog({ setup, open, onClose, onLinked }: { setup: boolean; open: boolean; onClose: () => void; onLinked: () => void }) {
  return (
    <Dialog title="Team" open={open} onClose={onClose}>
      <Suspense>{setup ? <SetUpTeam onLinked={onLinked} /> : <TeamWidgets />}</Suspense>
    </Dialog>
  );
}

/**
 * Team for this server's provider, in a dialog over the one holding the button: the self-hosted
 * issuer's Team, else the WorkOS widgets. Nothing where the server holds no team this person can open.
 */
export function TeamButton({ signIn, onSignInChange, label }: { signIn: Extract<SignInState, { status: 'signed_in' }>; onSignInChange: () => void; label: string }) {
  const [open, setOpen] = useState(false);
  if (!signIn.team && !signIn.workosTeam) return null;
  const close = () => setOpen(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>{label}</button>
      {signIn.team
        ? <Suspense><TeamDialog access={signIn.access} open={open} onClose={close} /></Suspense>
        : <WorkosTeamDialog setup={signIn.workosTeam === 'setup'} open={open} onClose={close} onLinked={onSignInChange} />}
    </>
  );
}

/** Display name and password at the self-hosted issuer, in a dialog over Settings; its code loads only with that issuer. */
function ProfileEdit() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <WithAction text="Display name and password" label="Edit" onClick={() => setOpen(true)} />
      <Suspense><ProfileDialog open={open} onClose={() => setOpen(false)} /></Suspense>
    </>
  );
}

/** The self-hosted issuer adds a Profile row. Team shows on the Workspace row. */
function accountRows(signIn: SignInState, onSignInChange: () => void): ReadonlyArray<Row> {
  const workspace: Row = ['Workspace', (
    <>
      <span>{WORKSPACE[signIn.status]}</span>
      <span className="listen-signin-actions">{signIn.status === 'signed_in' && <TeamButton signIn={signIn} onSignInChange={onSignInChange} label="Team" />}</span>
    </>
  )];
  if (signIn.status !== 'signed_in' || !signIn.team) return [workspace];
  return [['Profile', <ProfileEdit />], workspace];
}

/** The connect flow needs a session; until then the row says what is missing, as the Workspace row does. */
function IntegrationsRow({ signIn }: { signIn: SignInState }) {
  return signIn.status === 'signed_in' ? <Integrations /> : <span>{WORKSPACE[signIn.status]}</span>;
}

/** Settings overlay: real device and session facts, and the unselected policies stated as unselected. */
export function SettingsDialog({ open, onClose, permission, engine, client, signIn, notice, onSignInChange, onWelcome }: SettingsProps) {
  const rows: ReadonlyArray<Row> = [
    ['Sign-in', <SignInRow signIn={signIn} onSignInChange={onSignInChange} />],
    ...accountRows(signIn, onSignInChange),
    ['Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone],
    ['Microphone', <><span>{MICROPHONE[permission]}</span><InputPicker engine={engine} check /></>],
    ['Integrations', <IntegrationsRow signIn={signIn} />],
    ['Retention', 'Not selected: nothing is deleted automatically'],
    ...(onWelcome ? [['Welcome', <WithAction text="What Sanctum records and how to set it up" label="Show welcome again" onClick={onWelcome} />] as const] : []),
  ];
  return (
    <Dialog title="Settings" open={open} onClose={onClose}>
      {notice && <Notice notice={notice} selfServe={signIn.status === 'signed_out' && signIn.selfServe} />}
      <dl className="listen-panel listen-settings">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <LocalRecordings engine={engine} />
      <WorkspaceDeletion client={client} onDeleted={() => void engine.pause()} />
    </Dialog>
  );
}
