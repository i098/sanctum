/**
 * Promise client for the Sanctum v1 API (plan section 13). Operations come from the generated
 * table; this file holds the handwritten parts: transport, typed errors, safe retries,
 * cancellation, cursor pages and action receipts. No runtime dependency beyond `fetch`.
 */
import { type ActionReceipt, operations, type Operations } from './generated.ts';

export interface OperationSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly pathParams: ReadonlyArray<string>;
  readonly queryParams: ReadonlyArray<string>;
  readonly body: boolean;
}

export type OperationId = keyof Operations;
export type Input<Id extends OperationId> = Operations[Id]['input'];
export type Output<Id extends OperationId> = Operations[Id]['output'];

/** Error envelope shared by REST, SDKs and MCP; `body` keeps typed details such as `current_revision`. */
export class SanctumError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly body: Readonly<Record<string, unknown>>;
  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super(typeof body['message'] === 'string' ? body['message'] : `HTTP ${status}`);
    this.name = 'SanctumError';
    this.status = status;
    this.code = typeof body['code'] === 'string' ? body['code'] : 'http_error';
    this.retryable = body['retryable'] === true || status === 429;
    this.body = body;
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Agent credential or delegated access token, sent as `Authorization: Bearer`. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
  /** Total attempts for safe requests: reads, and writes carrying an `idempotency_key`. Default 3. */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

type Group<Id> = Id extends `${infer G}.${string}` ? G : never;
type Facade = {
  [G in Group<OperationId>]: {
    [Id in OperationId as Id extends `${G}.${infer Name}` ? Name : never]: (input: Input<Id>, options?: CallOptions) => Promise<Output<Id>>;
  };
};

export type SanctumClient = Facade & {
  call<Id extends OperationId>(operation: Id, input: Input<Id>, options?: CallOptions): Promise<Output<Id>>;
};

/** One HTTP exchange: resolves the parsed body, or rejects with `SanctumError` or fetch's `TypeError`. */
async function send(doFetch: typeof fetch, url: URL, init: RequestInit): Promise<unknown> {
  const response = await doFetch(url, init);
  const text = await response.text();
  const body: unknown = text === '' ? null : JSON.parse(text);
  if (response.ok) return body;
  throw new SanctumError(response.status, typeof body === 'object' && body !== null ? { ...body } : {});
}

function request(spec: OperationSpec, baseUrl: string, values: Readonly<Record<string, unknown>>) {
  const url = new URL(spec.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(values[name]))), baseUrl);
  for (const name of spec.queryParams) if (values[name] !== undefined) url.searchParams.set(name, String(values[name]));
  const fields = Object.entries(values).filter(([name]) => !spec.pathParams.includes(name) && !spec.queryParams.includes(name));
  return { url, body: spec.body ? JSON.stringify(Object.fromEntries(fields)) : null };
}

export function createClient(options: ClientOptions): SanctumClient {
  const doFetch = options.fetch ?? fetch;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.retryDelayMs ?? 200;

  async function call<Id extends OperationId>(operation: Id, input: Input<Id>, callOptions: CallOptions = {}): Promise<Output<Id>> {
    const spec = operations[operation];
    const values: Readonly<Record<string, unknown>> = input;
    const { url, body } = request(spec, options.baseUrl, values);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== null) headers['content-type'] = 'application/json';
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
    // Retrying is safe for reads and for writes the server deduplicates by idempotency key.
    const safe = spec.method === 'GET' || typeof values['idempotency_key'] === 'string';
    for (let attempt = 1; ; attempt++) {
      try {
        // The generated table and the server share one contract; the body is that operation's output.
        const output = (await send(doFetch, url, { method: spec.method, headers, body, signal: callOptions.signal ?? null })) as Output<Id>;
        return output;
      } catch (error) {
        // fetch rejects with TypeError on network failure; aborts and non-retryable statuses are final.
        const transient = error instanceof TypeError || (error instanceof SanctumError && error.retryable);
        if (!safe || !transient || attempt >= maxAttempts || callOptions.signal?.aborted) throw error;
        const hinted = error instanceof SanctumError ? error.body['retry_after_ms'] : undefined;
        await sleep(typeof hinted === 'number' ? hinted : baseDelay * 2 ** (attempt - 1), callOptions.signal);
      }
    }
  }

  const facade: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(operations)) {
    const [group = '', name = ''] = id.split('.');
    (facade[group] ??= {})[name] = (input: never, callOptions?: CallOptions) => call(id as OperationId, input, callOptions);
  }
  // The loop above installs exactly the generated operations under their group and name.
  const client = Object.assign(facade, { call }) as unknown as SanctumClient;
  return client;
}

type Paged = {
  [Id in OperationId]: Output<Id> extends { readonly items: ReadonlyArray<unknown>; readonly next_cursor: string | null } ? Id : never;
}[OperationId];

/** Cursor pages in order; stops on a null cursor or an empty page. Keep `next_cursor` to resume later. */
export async function* pages<Id extends Paged>(client: SanctumClient, operation: Id, input: Input<Id>, options?: CallOptions) {
  let next: Input<Id> = input;
  for (;;) {
    const page: Output<Paged> = await client.call(operation, next, options);
    yield page as Output<Id>;
    if (page.next_cursor === null || page.items.length === 0) return;
    next = { ...next, cursor: page.next_cursor };
  }
}

const TERMINAL: Record<ActionReceipt['state'], boolean> = {
  proposed: false,
  awaiting_authorization: false,
  queued: false,
  running: false,
  succeeded: true,
  failed: true,
  unknown: true,
  cancelled: true,
};

/** Polls `GET /actions/{id}` until the receipt is terminal; `unknown` means submitted but unreconciled. */
export async function waitForAction(client: SanctumClient, action_id: string, options: CallOptions & { readonly intervalMs?: number } = {}) {
  for (;;) {
    const receipt = await client.actions.getAction({ action_id }, options);
    if (TERMINAL[receipt.state]) return receipt;
    await sleep(options.intervalMs ?? 1_000, options.signal);
  }
}
