import type { WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';

type Close = (message: string) => void;

const open = new Map<string, Set<Close>>();

const workspaceKey = (workspace_id: WorkspaceId) => `workspace:${workspace_id}`;
const credentialKey = (credential_id: string) => `credential:${credential_id}`;

const add = (key: string, close: Close) => open.set(key, (open.get(key) ?? new Set()).add(close));

const remove = (key: string, close: Close) => {
  const sockets = open.get(key);
  sockets?.delete(close);
  if (sockets?.size === 0) open.delete(key);
};

const closeAll = (key: string, message: string) =>
  Effect.sync(() => {
    for (const close of [...(open.get(key) ?? [])]) close(message);
  });

/** Lists a live listener socket of this process under its workspace and credential until the current scope ends. */
export const trackSocket = (access: { readonly workspace_id: WorkspaceId; readonly credential_id?: string | undefined }, close: Close) => {
  const keys = [workspaceKey(access.workspace_id), ...(access.credential_id === undefined ? [] : [credentialKey(access.credential_id)])];
  return Effect.acquireRelease(
    Effect.sync(() => keys.forEach(key => add(key, close))),
    () => Effect.sync(() => keys.forEach(key => remove(key, close))),
  );
};

/** Ends every live listener socket this process holds for the workspace; each client is told its access ended. */
export const closeWorkspaceSockets = (workspace_id: WorkspaceId) => closeAll(workspaceKey(workspace_id), 'This workspace was deleted');

/** Ends every live listener socket this process holds for the credential; each client is told its access ended. */
export const closeCredentialSockets = (credential_id: string) => closeAll(credentialKey(credential_id), 'This credential was revoked');
