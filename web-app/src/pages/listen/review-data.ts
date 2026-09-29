/**
 * Review dialog data read through the same v1 SDK the agents use. Each frame settles on its
 * own: a failing source shows its real error and never blanks or fakes the others.
 */
import { SanctumError } from '@sanctum/sdk';

export type Frame<A> = { readonly status: 'ok'; readonly data: A } | { readonly status: 'error'; readonly code: string; readonly message: string };

export const settle = <A>(promise: Promise<A>): Promise<Frame<A>> =>
  promise.then(
    data => ({ status: 'ok', data }),
    (error: unknown) =>
      error instanceof SanctumError
        ? { status: 'error', code: error.code, message: error.message }
        : { status: 'error', code: 'network', message: error instanceof Error ? error.message : String(error) },
  );
