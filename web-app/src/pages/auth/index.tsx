/**
 * Pages of the embedded issuer (server/src/issuer.ts): Better Auth sends the browser here during
 * an authorization request. The client plugin forwards the signed request with each call and
 * follows the redirect back to the client when Better Auth answers with one.
 */
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { createAuthClient } from 'better-auth/client';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

const auth = createAuthClient({ baseURL: `${location.origin}/idp`, plugins: [oauthProviderClient()] });

const input = 'w-full rounded border border-divider bg-surface px-3 py-2 text-ink outline-none focus-visible:border-accent';
const primary = 'rounded bg-accent px-4 py-2 font-medium text-ink disabled:opacity-60';

type Failure = { readonly message?: string | undefined } | null;

function Card({ title, error, children }: { title: string; error: Failure; children: ReactNode }) {
  return (
    <main className="flex h-full items-center justify-center p-6">
      <section className="w-full max-w-sm rounded-lg border border-divider bg-overlay p-7 text-sm">
        <h1 className="mb-5 text-base font-medium">{title}</h1>
        {children}
        {error && (
          <p role="alert" className="mt-4 text-warning">
            {error.message ?? 'The request failed'}
          </p>
        )}
      </section>
    </main>
  );
}

const field = (form: FormData, name: string) => String(form.get(name));

const MODES = {
  'sign-in': {
    title: 'Sign in to Sanctum',
    action: 'Sign in',
    password: 'current-password',
    other: { path: '/sign-up', label: 'Create an account' },
    send: (form: FormData) => auth.signIn.email({ email: field(form, 'email'), password: field(form, 'password') }),
  },
  'sign-up': {
    title: 'Create a Sanctum account',
    action: 'Create account',
    password: 'new-password',
    other: { path: '/sign-in', label: 'Sign in instead' },
    send: (form: FormData) => auth.signUp.email({ name: field(form, 'name'), email: field(form, 'email'), password: field(form, 'password') }),
  },
};

/** Email and password sign-in or registration; without a pending authorization it returns home. */
export function AccountPage({ mode }: { mode: keyof typeof MODES }) {
  const copy = MODES[mode];
  const [error, setError] = useState<Failure>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const { data, error } = await copy.send(new FormData(event.currentTarget));
    setBusy(false);
    setError(error);
    // With a pending authorization Better Auth answers `redirect: true` and the client follows it.
    if (data && !('redirect' in data && data.redirect)) location.assign('/');
  };
  return (
    <Card title={copy.title} error={error}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        {mode === 'sign-up' && (
          <label className="flex flex-col gap-1">
            Name
            <input className={input} name="name" autoComplete="name" required />
          </label>
        )}
        <label className="flex flex-col gap-1">
          Email
          <input className={input} name="email" type="email" autoComplete="email" required />
        </label>
        <label className="flex flex-col gap-1">
          Password
          <input className={input} name="password" type="password" minLength={8} autoComplete={copy.password} required />
        </label>
        <button className={primary} type="submit" disabled={busy}>
          {copy.action}
        </button>
      </form>
      {/* The query carries the pending authorization request to the other page. */}
      <a className="mt-4 inline-block text-ink-secondary underline" href={`${copy.other.path}${location.search}`}>
        {copy.other.label}
      </a>
    </Card>
  );
}

/** Approve or deny a client's requested scopes; Better Auth then redirects back to the client. */
export function ConsentPage() {
  const query = new URLSearchParams(location.search);
  const clientId = query.get('client_id') ?? '';
  const [client, setClient] = useState(clientId);
  const [error, setError] = useState<Failure>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void auth.$fetch<{ client_name?: string }>('/oauth2/public-client', { query: { client_id: clientId } }).then(({ data }) => {
      if (data?.client_name) setClient(data.client_name);
    });
  }, [clientId]);
  const answer = async (accept: boolean) => {
    setBusy(true);
    const { error } = await auth.$fetch('/oauth2/consent', { method: 'POST', body: { accept } });
    setBusy(false);
    setError(error);
  };
  return (
    <Card title="Allow access?" error={error}>
      <p className="mb-3 text-ink-secondary">
        <span className="text-ink">{client}</span> asks for:
      </p>
      <ul className="mb-5 list-disc pl-5 font-mono text-xs">
        {(query.get('scope') ?? '').split(' ').filter(Boolean).map(scope => (
          <li key={scope}>{scope}</li>
        ))}
      </ul>
      <div className="flex gap-3">
        <button className={primary} type="button" disabled={busy} onClick={() => void answer(true)}>
          Allow
        </button>
        <button className="rounded border border-divider px-4 py-2" type="button" disabled={busy} onClick={() => void answer(false)}>
          Deny
        </button>
      </div>
    </Card>
  );
}
