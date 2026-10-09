import { type SanctumClient, SanctumError, type Workspace } from '@sanctum/sdk';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.tsx';

const describeFailure = (error: unknown) =>
  error instanceof SanctumError && error.status < 500 ? `${error.message}; nothing was changed.` : 'The change could not be confirmed; reopen Settings to check.';

interface ConfirmProps {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
}

/** The confirm form; it lives inside the dialog, so closing the dialog forgets what was typed. */
function ConfirmDeletion({ name, busy, onCancel, onConfirm }: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConfirm(typed);
  };
  return (
    <form className="listen-panel listen-confirm" onSubmit={submit}>
      <p>Everyone loses access to {name} at once. After the grace period its recordings, transcripts and memory are purged permanently; until then you can undo in Settings. Connected third-party accounts are not disconnected by this and must be disconnected separately.</p>
      <label>
        <span>Type <strong>{name}</strong> to confirm</span>
        <input value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false} autoFocus />
      </label>
      <div className="listen-local-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" data-danger disabled={busy || typed !== name}>Delete workspace</button>
      </div>
    </form>
  );
}

/**
 * Owner-only Settings section: delete the workspace after typing its name, and undo while the
 * grace period runs. Hidden for anyone the server does not answer as the owner.
 */
export function WorkspaceDeletion({ client }: { client: SanctumClient }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useFocusAfterRender(heading);
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    client.workspace.getWorkspace({}, { signal: controller.signal }).then(setWorkspace, () => setWorkspace(null));
    return () => controller.abort();
  }, [client]);
  if (workspace === null) return null;

  /** Either outcome closes the confirm dialog; a failure shows in the section. */
  const run = (change: () => Promise<Workspace>) => {
    setBusy(true);
    setFailure(null);
    change()
      .then(setWorkspace, (error: unknown) => setFailure(describeFailure(error)))
      .finally(() => {
        setBusy(false);
        setConfirming(false);
        focusHeading();
      });
  };
  const { title, text } = copy(workspace);
  return (
    <section className="listen-panel listen-workspace" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>{title}</h3>
      <p>{text}</p>
      <div className="listen-local-actions">
        {workspace.purge_after === null
          ? <button type="button" data-danger onClick={() => setConfirming(true)}>Delete workspace…</button>
          : <button type="button" data-primary disabled={busy} onClick={() => run(() => client.workspace.restoreWorkspace({}))}>Undo deletion</button>}
      </div>
      {failure && <p role="alert" className="listen-local-gap">{failure}</p>}
      <Dialog title="Delete workspace?" open={confirming} onClose={() => setConfirming(false)}>
        <ConfirmDeletion name={workspace.name} busy={busy} onCancel={() => setConfirming(false)} onConfirm={typed => run(() => client.workspace.deleteWorkspace({ confirm_name: typed }))} />
      </Dialog>
    </section>
  );
}

const copy = ({ name, purge_after }: Workspace) =>
  purge_after === null
    ? {
      title: 'Delete workspace',
      text: `Deletes ${name} with its recordings, transcripts and memory. Members, sessions and agents lose access at once. You can undo during a grace period; after it, everything is purged permanently.`,
    }
    : {
      title: 'Workspace deleted',
      text: `${name} is deleted, and members, sessions and agents have no access. Its recordings, transcripts and memory are purged permanently after ${new Date(purge_after).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Until then you can undo; undo does not run agent actions that were queued, so request them again.`,
    };

/** Returns `request()`: focuses `ref` after the next render, when a closed dialog has already returned focus to its now-gone opener. */
function useFocusAfterRender(ref: RefObject<HTMLElement | null>) {
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    ref.current?.focus();
  });
  return () => void (pending.current = true);
}
