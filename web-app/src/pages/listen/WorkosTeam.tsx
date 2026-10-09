/**
 * Hosted Team overlay (sign-in plan W2): the signed-in owner's or admin's WorkOS profile and the
 * workspace's members (invite, remove, change role) in the WorkOS widgets, or "Set up team" for the
 * owner of a workspace that has no WorkOS organization yet. Settings loads this module when Team
 * first opens, so the listening page never ships the widgets, Radix Themes or their styles.
 */
import '@radix-ui/themes/styles.css';
import '@workos-inc/widgets/styles.css';
import './team.css';
import { UserProfile, UsersManagement, WorkOsWidgets, type WorkOsWidgetsProps } from '@workos-inc/widgets';
import { useEffect, useState } from 'react';
import { post } from '../../lib/session.ts';

const THEME: NonNullable<WorkOsWidgetsProps['theme']> = {
  appearance: 'dark',
  accentColor: 'blue',
  grayColor: 'slate',
  radius: 'small',
  panelBackground: 'solid',
  hasBackground: false,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

/** The owner links a workspace created before WorkOS; `onLinked` re-reads sign-in, which then loads the widgets. */
export function SetUpTeam({ onLinked }: { onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const setUp = () => {
    setBusy(true);
    setFailure(null);
    post('/api/v1/workspace/team').then(onLinked, (error: Error) => {
      setFailure(error.message);
      setBusy(false);
    });
  };
  return (
    <div className="listen-team listen-panel listen-confirm">
      <p>This workspace has no team yet. Set up team creates it in WorkOS with you as the owner, so you can invite members and change their roles here.</p>
      <p>Current members keep their access. Each one joins the team after accepting your invitation and signing in.</p>
      <div className="listen-local-actions">
        <button type="button" data-primary disabled={busy} onClick={setUp}>Set up team</button>
      </div>
      {failure && <p role="alert" className="listen-local-gap">{failure}</p>}
    </div>
  );
}

export function TeamWidgets() {
  const [token, setToken] = useState<string | Error | null>(null);
  // The widgets' dialogs and menus portal here: outside the open modal dialog the page is inert.
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  // A one-hour widget token for this workspace's organization; a refusal shows the server's reason.
  useEffect(() => void post('/api/v1/workspace/widget-token').then(response => response.json()).then(body => setToken(body.token), setToken), []);
  if (token === null) return <p className="listen-panel">Loading the team…</p>;
  if (token instanceof Error) return <p role="alert" className="listen-panel listen-local-gap">{token.message}</p>;
  // `container` is a Radix Themes prop the widgets pass through but leave out of their types.
  const elements = { dialog: { container: portal }, dropdown: { container: portal } } as NonNullable<WorkOsWidgetsProps['elements']>;
  return (
    <div ref={setPortal} className="listen-team">
      <WorkOsWidgets theme={THEME} elements={elements}>
        <section aria-label="Your profile">
          <h3>Your profile</h3>
          <UserProfile authToken={token} />
        </section>
        <section aria-label="Members">
          <h3>Members</h3>
          <UsersManagement authToken={token} />
        </section>
      </WorkOsWidgets>
    </div>
  );
}
