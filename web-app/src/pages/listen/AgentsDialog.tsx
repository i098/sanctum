/**
 * Agents: scoped credentials for SDK and MCP clients, and their revocation (plan section 14).
 * Calls the same v1 agents operations as every other client; the plain token is shown once.
 */
import { type AgentCredential, type SanctumClient, SanctumError } from '@sanctum/sdk';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Dialog } from './Dialog.tsx';

type Scope = AgentCredential['scopes'][number];
const GRANTABLE: ReadonlyArray<{ scope: Scope; label: string }> = [
  { scope: 'context:read', label: 'Read context' },
  { scope: 'context:write', label: 'Add context' },
  { scope: 'recordings:read', label: 'Play recordings' },
  { scope: 'actions:request', label: 'Request actions' },
];

const describe = (error: unknown) => (error instanceof SanctumError ? error.message : 'Network unavailable; nothing was changed.');

export function AgentsDialog({ client, open, onClose }: { client: SanctumClient; open: boolean; onClose: () => void }) {
  const [credentials, setCredentials] = useState<ReadonlyArray<AgentCredential> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      client.agents.listAgents({}, signal ? { signal } : {}).then(
        page => (setCredentials(page.items), setError(null)),
        (failure: unknown) => signal?.aborted || setError(describe(failure)),
      ),
    [client],
  );
  useEffect(() => {
    // The plain token is shown once: closing the dialog forgets it.
    if (!open) return setIssued(null);
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh]);

  const run = async (change: () => Promise<void>) => {
    setBusy(true);
    try {
      await change();
      await refresh();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const display_name = String(form.get('name')).trim();
    const scopes = GRANTABLE.map(g => g.scope).filter(scope => form.has(scope));
    if (scopes.length === 0) return setError('Choose at least one permission.');
    const target = event.currentTarget;
    void run(async () => {
      const created = await client.agents.createAgent({ display_name, scopes, meeting_ids: null, expires_at: null });
      setIssued({ name: display_name, token: created.token });
      target.reset();
    });
  };

  const revoke = (credential: AgentCredential) => {
    if (!window.confirm(`Revoke ${credential.display_name}? Its clients lose access immediately.`)) return;
    void run(async () => void (await client.agents.revokeCredential({ agent_id: credential.agent_id, credential_id: credential.credential_id })));
  };

  return (
    <Dialog title="Agents" open={open} onClose={onClose}>
      {error && (
        <p role="alert" className="mb-3 text-warning">
          {error}
        </p>
      )}
      {issued && (
        <div role="status" className="mb-4 rounded bg-surface p-3">
          <p className="text-sm text-ink-secondary">Token for {issued.name}. Copy it now; it is not shown again.</p>
          <code className="block break-all font-mono text-sm" aria-label="New agent token">
            {issued.token}
          </code>
        </div>
      )}
      <ul aria-label="Agent credentials" className="mb-4 divide-y divide-divider">
        {credentials === null && !error && <li className="py-2 text-ink-muted">Loading…</li>}
        {credentials?.length === 0 && <li className="py-2 text-ink-muted">No agents yet.</li>}
        {credentials?.map(credential => (
          <li key={credential.credential_id} className="flex items-center justify-between gap-3 py-2">
            <span>
              {credential.display_name}
              <span className="block text-sm text-ink-muted">
                {credential.revoked_at ? `Revoked ${credential.revoked_at}` : credential.scopes.join(', ')}
              </span>
            </span>
            {!credential.revoked_at && (
              <button type="button" disabled={busy} onClick={() => revoke(credential)} className="rounded px-3 py-1 text-warning hover:bg-surface">
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="grid gap-3">
        <label className="grid gap-1">
          <span className="text-sm text-ink-secondary">Agent name</span>
          <input name="name" required maxLength={200} className="rounded bg-surface px-3 py-2" />
        </label>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 text-sm text-ink-secondary">Permissions</legend>
          {GRANTABLE.map(({ scope, label }) => (
            <label key={scope} className="flex items-center gap-2">
              <input type="checkbox" name={scope} defaultChecked={scope === 'context:read'} />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-4 py-2 hover:bg-surface">
            Close
          </button>
          <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2">
            Create agent
          </button>
        </div>
      </form>
    </Dialog>
  );
}
