import type { SanctumClient } from '@sanctum/sdk';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { CaptureView, PermissionState } from '../../lib/capture/view.ts';
import { connectSignIn, SIGN_IN_URL, signOut, type SignInNotice, type SignInState } from '../../lib/session.ts';
import { Dialog } from './Dialog.tsx';
import { LocalRecordings } from './LocalRecordings.tsx';
import { WorkspaceDeletion } from './WorkspaceDeletion.tsx';

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
}

/** Self-serve: signs in again, and the server creates the workspace with this user as owner when it still finds no membership. */
function CreateWorkspace() {
  // The browser's own zone may be an alias (such as `UTC`) that the canonical list leaves out.
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = Intl.supportedValuesOf('timeZone');
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams({ return_to: '/', workspace_name: String(form.get('name')).trim(), timezone: String(form.get('timezone')) });
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

/**
 * Sign out shows only with a configured issuer: without one, the session came from the operator's
 * login link, and revoking it would leave no way back in.
 */
function SignedIn({ signIn, onSignInChange }: { signIn: Extract<SignInState, { status: 'signed_in' }>; onSignInChange: () => void }) {
  const [failure, setFailure] = useState<string | null>(null);
  const run = (action: () => Promise<void>, failed: string) => {
    setFailure(null);
    action().then(onSignInChange, () => setFailure(failed));
  };
  return (
    <>
      <span>Signed in as {signIn.access.principal.display_name} ({signIn.access.role})</span>
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

/** Settings overlay: real device and session facts, and the unselected policies stated as unselected. */
export function SettingsDialog({ open, onClose, permission, engine, client, signIn, notice, onSignInChange }: SettingsProps) {
  const rows: ReadonlyArray<readonly [string, ReactNode]> = [
    ['Sign-in', <SignInRow signIn={signIn} onSignInChange={onSignInChange} />],
    ['Workspace', WORKSPACE[signIn.status]],
    ['Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone],
    ['Microphone', MICROPHONE[permission]],
    ['Integrations', 'Unavailable: integrations are not connected yet'],
    ['Retention', 'Not selected: nothing is deleted automatically'],
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
      <WorkspaceDeletion client={client} />
    </Dialog>
  );
}
