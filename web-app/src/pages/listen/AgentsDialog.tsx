/**
 * Agents: scoped credentials for SDK and MCP clients, and their revocation (plan section 14).
 * Calls the same v1 agents operations as every other client; the plain token is shown once.
 */
import { type AgentWithCredential, type SanctumClient, SanctumError } from '@sanctum/sdk';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Dialog } from './Dialog.tsx';

type Scope = AgentWithCredential['credential']['scopes'][number];
const GRANTABLE: ReadonlyArray<{ scope: Scope; label: string }> = [
  { scope: 'context:read', label: 'Read context' },
  { scope: 'context:write', label: 'Add context' },
  { scope: 'recordings:read', label: 'Play recordings' },
  { scope: 'actions:request', label: 'Request actions' },
];

export function AgentsDialog({ client, open, onClose }: { client: SanctumClient; open: boolean; onClose: () => void }) {
  const [agents, setAgents] = useState<ReadonlyArray<AgentWithCredential> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const page = await client.agents.listAgents({}, signal ? { signal } : {});
      setAgents(page.items);
      setError(null);
    },
    [client],
  );
  useEffect(() => {
    // The plain token is shown once: closing the dialog forgets it.
    if (!open) return setIssued(null);
    const controller = new AbortController();
    refresh(controller.signal).catch((failure: unknown) => controller.signal.aborted || setError(failure instanceof SanctumError ? failure.message : 'Network unavailable.'));
    return () => controller.abort();
  }, [open, refresh]);

  const run = async (change: () => Promise<void>) => {
    setBusy(true);
    try {
      try {
        await change();
      } catch (failure) {
        return setError(
          failure instanceof SanctumError && failure.status < 500
            ? `${failure.message}; nothing was changed.`
            : 'The change could not be confirmed; reopen Agents to check before retrying.',
        );
      }
      await refresh().catch((failure: unknown) =>
        setError(`The change was made, but the list could not be refreshed: ${failure instanceof SanctumError ? failure.message : 'network unavailable'}.`),
      );
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
      const created = await client.agents.createAgent({ display_name, scopes, meetings: { kind: 'accessible' }, expires_at: null });
      setIssued({ name: display_name, token: created.token });
      target.reset();
    });
  };

  const revoke = ({ agent, credential }: AgentWithCredential) => {
    if (!window.confirm(`Revoke ${agent.display_name}? Its clients lose access immediately.`)) return;
    void run(async () => void (await client.agents.revokeCredential({ agent_id: agent.id, key_id: credential.id })));
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
        {agents === null && !error && <li className="py-2 text-ink-muted">Loading…</li>}
        {agents?.length === 0 && <li className="py-2 text-ink-muted">No agents yet.</li>}
        {agents?.map(({ agent, credential }) => (
          <li key={credential.id} className="flex items-center justify-between gap-3 py-2">
            <span>
              {agent.display_name}
              <span className="block text-sm text-ink-muted">
                {credential.revoked_at ? `Revoked ${credential.revoked_at}` : credential.scopes.join(', ')}
              </span>
            </span>
            {!credential.revoked_at && (
              <button type="button" disabled={busy} onClick={() => revoke({ agent, credential })} className="rounded px-3 py-1 text-warning hover:bg-surface">
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
          <button type="submit" disabled={busy} className="rounded bg-accent px-4 py-2">
            Create agent
          </button>
        </div>
      </form>
    </Dialog>
  );
}
