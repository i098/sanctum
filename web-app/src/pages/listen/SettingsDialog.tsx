import { useState, type ReactNode } from 'react';
import type { CaptureView, PermissionState } from '../../lib/capture/view.ts';
import { connectSignIn, SIGN_IN_URL, signOut, type SignInNotice, type SignInState } from '../../lib/session.ts';
import { Dialog } from './Dialog.tsx';
import { LocalRecordings } from './LocalRecordings.tsx';

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
}

function Notice({ notice }: { notice: SignInNotice }) {
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
export function SettingsDialog({ open, onClose, permission, engine, signIn, notice, onSignInChange }: SettingsProps) {
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
      {notice && <Notice notice={notice} />}
      <dl className="listen-panel listen-settings">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <LocalRecordings engine={engine} />
    </Dialog>
  );
}
