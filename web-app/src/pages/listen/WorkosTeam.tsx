/**
 * Hosted Team overlay (sign-in plan W2): the signed-in owner's or admin's WorkOS profile and the
 * workspace's members (invite, remove, change role) in the WorkOS widgets. Settings loads this
 * module when Team first opens, so the listening page never ships the widgets, Radix Themes or their styles.
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
