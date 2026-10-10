import type { ConnectedIntegrationAccount, IntegrationAccounts } from '@sanctum/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import { post } from '../../lib/session.ts';

/** Offered in the app field; any Pipedream app slug can be typed. */
const SUGGESTED_APPS = ['gmail', 'google_calendar', 'google_drive', 'google_docs', 'notion', 'slack', 'github'];

const appName = (slug: string) => slug.split(/[_-]+/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');

const accounts = async (response: Promise<Response>): Promise<IntegrationAccounts> => (await response).json();

function ConnectedApps({ list, onDisconnect }: { list: ReadonlyArray<ConnectedIntegrationAccount>; onDisconnect: (id: string) => void }) {
  if (list.length === 0) return <p>No apps connected</p>;
  return (
    <ul>
      {list.map(account => (
        <li key={account.id}>
          <span className="listen-account-text">
            <span className="listen-account-name">{appName(account.app)}</span>
            <span className="listen-account-email">
              {account.grants.length === 0 ? 'No grants yet' : account.grants.map(grant => `${grant.action_key} for ${grant.grantee_name ?? 'a member'}`).join('; ')}
            </span>
          </span>
          <button type="button" onClick={() => onDisconnect(account.id)} aria-label={`Disconnect ${appName(account.app)}`}>Disconnect</button>
        </li>
      ))}
    </ul>
  );
}

/** Opens Pipedream's hosted Connect Link in a new tab, so this tab keeps capturing. */
function ConnectForm({ onStarted, onNotice }: { onStarted: () => void; onNotice: (notice: string | null) => void }) {
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const app = String(new FormData(event.currentTarget).get('app')).trim();
    // Opened inside the click, so the browser allows it; the link arrives after the request.
    const tab = window.open('', '_blank');
    if (!tab) return onNotice('The browser blocked the new tab. Allow pop-ups for this site, then connect again.');
    tab.opener = null;
    onNotice(null);
    post('/api/v1/integrations/connect', { app })
      .then(response => response.json())
      .then(({ url }: { url: string }) => {
        tab.location.href = url;
        onStarted();
      }, (error: Error) => {
        tab.close();
        onNotice(`The connection could not start: ${error.message}`);
      });
  };
  return (
    <form className="listen-integration-connect" onSubmit={connect}>
      <input name="app" list="listen-apps" required pattern="[a-z0-9_\-]{1,128}" aria-label="App to connect" placeholder="App, such as gmail" className="listen-input" />
      <datalist id="listen-apps">{SUGGESTED_APPS.map(app => <option key={app} value={app}>{appName(app)}</option>)}</datalist>
      <button type="submit" data-primary>Connect an app</button>
    </form>
  );
}

const STATUS = {
  checking: 'Checking',
  unavailable: 'Unavailable: the connected apps could not be read',
  unconfigured: 'Not configured: this server has no Pipedream settings',
};

/**
 * Settings' Integrations row: the person's connected apps with the grants they made on them, and
 * Connect. Coming back to this tab stores what was connected in Pipedream's. Connecting grants nothing.
 */
export function Integrations() {
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

  if (typeof state === 'string') return <span>{STATUS[state]}</span>;
  return (
    <div className="listen-integrations">
      <ConnectedApps list={state.accounts} onDisconnect={disconnect} />
      <ConnectForm onStarted={() => setWaiting(true)} onNotice={setNotice} />
      {waiting && <p>Finish in the Pipedream tab. This list updates when you come back to this tab.</p>}
      {notice && <p role="alert" className="listen-local-gap">{notice}</p>}
    </div>
  );
}
