import type { WorkspaceId } from '@sanctum/contracts';
import { Effect } from 'effect';

type Close = () => void;

const open = new Map<WorkspaceId, Set<Close>>();

/** Lists a live listener socket of this process under its workspace until the current scope ends. */
export const trackSocket = (workspace_id: WorkspaceId, close: Close) =>
  Effect.acquireRelease(
    Effect.sync(() => open.set(workspace_id, (open.get(workspace_id) ?? new Set()).add(close))),
    () =>
      Effect.sync(() => {
        const sockets = open.get(workspace_id);
        sockets?.delete(close);
        if (sockets?.size === 0) open.delete(workspace_id);
      }),
  );

/** Ends every live listener socket this process holds for the workspace; each client is told its access ended. */
export const closeWorkspaceSockets = (workspace_id: WorkspaceId) =>
  Effect.sync(() => {
    for (const close of [...(open.get(workspace_id) ?? [])]) close();
  });
