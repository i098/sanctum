import type { ConnectedIntegrationAccount, IntegrationAccounts } from '@sanctum/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { post, type SignInState } from '../../lib/session.ts';
import { WORKSPACE } from './SettingsSection.tsx';

/** Offered as tiles until connected; any other Pipedream app slug can be typed in "Any other app". */
const SUGGESTED_APPS: Readonly<Record<string, string>> = {
  gmail: 'Email',
  google_calendar: 'Events',
  google_drive: 'Files',
  google_docs: 'Documents',
  notion: 'Pages, databases',
  slack: 'Messages, channels',
  github: 'Issues, pull requests',
};

const appName = (slug: string) => slug.split(/[_-]+/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');

const accounts = async (response: Promise<Response>): Promise<IntegrationAccounts> => (await response).json();

const grantText = ({ grants }: ConnectedIntegrationAccount) =>
  grants.length === 0 ? 'No grants yet' : grants.map(grant => `${grant.action_key} for ${grant.grantee_name ?? 'a member'}`).join('; ');

const STATUS = {
  checking: 'Checking',
  unavailable: 'Unavailable: the connected apps could not be read',
  unconfigured: 'Not configured: this server has no Pipedream settings',
};

function ConnectedApps({ list, onDisconnect }: { list: ReadonlyArray<ConnectedIntegrationAccount>; onDisconnect: (id: string) => void }) {
  if (list.length === 0) return <p>No apps connected</p>;
  return (
    <ul className="listen-app-tiles">
      {list.map(account => (
        <li key={account.id} className="listen-app-tile">
          <span className="listen-account-name">{appName(account.app)}</span>
          <span className="listen-account-email">{grantText(account)}</span>
          <button type="button" onClick={() => onDisconnect(account.id)} aria-label={`Disconnect ${appName(account.app)}`}>Disconnect</button>
        </li>
      ))}
    </ul>
  );
}

/** Suggested apps not yet connected, then the tile that takes any other Pipedream app name. */
function AvailableApps({ connected, onConnect }: { connected: ReadonlySet<string>; onConnect: (app: string) => void }) {
  const connectTyped = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConnect(String(new FormData(event.currentTarget).get('app')).trim());
  };
  return (
    <ul className="listen-app-tiles">
      {Object.entries(SUGGESTED_APPS).filter(([slug]) => !connected.has(slug)).map(([slug, note]) => (
        <li key={slug} className="listen-app-tile">
          <span className="listen-account-name">{appName(slug)}</span>
          <span className="listen-account-email">{note}</span>
          <button type="button" data-primary onClick={() => onConnect(slug)} aria-label={`Connect ${appName(slug)}`}>Connect ↗</button>
        </li>
      ))}
      <li className="listen-app-tile" data-other>
        <form onSubmit={connectTyped}>
          <span className="listen-account-name">Any other app</span>
          <input name="app" required pattern="[a-z0-9_\-]{1,128}" aria-label="App to connect" placeholder="e.g. hubspot" className="listen-input" />
          <button type="submit" data-primary>Connect an app</button>
        </form>
      </li>
    </ul>
  );
}

/**
 * Apps: the person's connected apps with the grants they made on them, and the apps they can connect.
 * Connect opens Pipedream's hosted Connect Link in a new tab, so this tab keeps capturing; coming back
 * to this tab stores what was connected in Pipedream's. Connecting grants nothing.
 */
function Apps() {
  const [state, setState] = useState<IntegrationAccounts | keyof typeof STATUS>('checking');
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);

  const sync = () =>
    accounts(post('/api/v1/integrations/accounts/sync')).then(
      synced => {
        setState(synced);
        setNotice(null);
      },
      (error: Error) => setNotice(`Pipedream did not answer, so this list may be out of date: ${error.message}`),
    );

  useEffect(() => {
    // The stored list first, then whatever Pipedream reports; the stored one needs no provider call.
    accounts(fetch('/api/v1/integrations/accounts', { headers: { accept: 'application/json' } }).then(response => (response.ok ? response : Promise.reject(new Error()))))
      .then(stored => {
        setState(stored.configured ? stored : 'unconfigured');
        if (stored.configured) void sync();
      }, () => setState('unavailable'));
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const back = () => void sync();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [waiting]);

  const disconnect = (id: string) =>
    void accounts(post(`/api/v1/integrations/accounts/${id}/disconnect`)).then(setState, (error: Error) => setNotice(`Disconnect did not finish: ${error.message}`));

  const connect = (app: string) => {
    // Opened inside the click, so the browser allows it; the link arrives after the request.
    const tab = window.open('', '_blank');
    if (!tab) return setNotice('The browser blocked the new tab. Allow pop-ups for this site, then connect again.');
    tab.opener = null;
    setNotice(null);
    post('/api/v1/integrations/connect', { app })
      .then(response => response.json())
      .then(({ url }: { url: string }) => {
        tab.location.href = url;
        setWaiting(true);
      }, (error: Error) => {
        tab.close();
        setNotice(`The connection could not start: ${error.message}`);
      });
  };

  if (typeof state === 'string') return <p>{STATUS[state]}</p>;
  return (
    <div className="listen-panel listen-apps">
      <h3>Connected</h3>
      <ConnectedApps list={state.accounts} onDisconnect={disconnect} />
      <h3>Available</h3>
      <AvailableApps connected={new Set(state.accounts.map(account => account.app))} onConnect={connect} />
      <p className="listen-apps-note">Connect opens Pipedream in a new tab. This tab keeps listening.</p>
      {waiting && <p>Finish in the Pipedream tab. This list updates when you come back to this tab.</p>}
      {notice && <p role="alert" className="listen-local-gap">{notice}</p>}
    </div>
  );
}

/** The connect flow needs a session; until then the section says what is missing, as Settings' Workspace row does. */
export function AppsSection({ signIn }: { signIn: SignInState }) {
  return signIn.status === 'signed_in' ? <Apps /> : <p>{WORKSPACE[signIn.status]}</p>;
}
