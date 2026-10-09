/** In-memory R2 stand-in for tests: records every call and can inject failures per operation. */
import { Effect, Layer } from 'effect';
import { ObjectStore, ObjectStoreError, type StoredObject } from '../../src/providers/object-store.ts';

type Operation = ObjectStoreError['operation'];

export interface MemoryObjectStore {
  readonly layer: Layer.Layer<ObjectStore>;
  readonly objects: Map<string, { readonly body: Uint8Array; readonly sha256: string; readonly contentType: string }>;
  /** Keys in the order they were deleted, one entry per successful delete. */
  readonly deleted: Array<string>;
  /**
   * Makes the next call of `operation` fail, or the call after `after` more successful ones;
   * `ambiguous` simulates a timeout after the write landed.
   */
  failNext(operation: Operation, options?: { readonly ambiguous?: boolean; readonly after?: number }): void;
  /** Wall clock used to sign and verify URLs, replaceable for expiry tests. */
  now: () => number;
  verifySignedUrl(url: string): string | null;
}

export function memoryObjectStore(): MemoryObjectStore {
  const objects: MemoryObjectStore['objects'] = new Map();
  const failures = new Map<Operation, { ambiguous: boolean; after: number }>();
  const deleted: Array<string> = [];
  const store: MemoryObjectStore = {
    objects,
    deleted,
    failNext: (operation, options) => void failures.set(operation, { ambiguous: options?.ambiguous ?? false, after: options?.after ?? 0 }),
    now: () => Date.now(),
    verifySignedUrl: url => {
      const parsed = new URL(url);
      return Number(parsed.searchParams.get('expires')) > store.now() ? decodeURIComponent(parsed.pathname.slice(1)) : null;
    },
    layer: Layer.sync(ObjectStore, () => ({ put, head, get, presignGet, list, delete: remove })),
  };
  const attempt = <A>(operation: Operation, key: string, run: () => A) =>
    Effect.suspend(() => {
      const failure = failures.get(operation);
      if (failure === undefined) return Effect.succeed(run());
      if (failure.after-- > 0) return Effect.succeed(run());
      failures.delete(operation);
      if (failure.ambiguous) run();
      return Effect.fail(new ObjectStoreError({ operation, key, ambiguous: failure.ambiguous, message: 'injected failure' }));
    });
  const describe = (key: string): StoredObject | null => {
    const object = objects.get(key);
    return object ? { key, byte_length: object.body.byteLength, sha256: object.sha256 } : null;
  };
  const put = (key: string, body: Uint8Array, meta: { readonly sha256: string; readonly contentType: string }) =>
    attempt('put', key, () => {
      objects.set(key, { body: body.slice(), ...meta });
      return describe(key)!;
    });
  const head = (key: string) => attempt('head', key, () => describe(key));
  const get = (key: string) =>
    Effect.flatMap(attempt('get', key, () => objects.get(key)), object =>
      object ? Effect.succeed(object.body.slice()) : Effect.fail(new ObjectStoreError({ operation: 'get', key, ambiguous: false, message: 'not found' })),
    );
  const presignGet = (key: string, ttlMs: number) =>
    attempt('presign', key, () => `https://objects.test/${encodeURIComponent(key)}?expires=${store.now() + ttlMs}`);
  const list = (prefix: string) => attempt('list', prefix, () => [...objects.keys()].filter(key => key.startsWith(prefix)).sort().slice(0, 1000));
  const remove = (key: string) =>
    attempt('delete', key, () => {
      if (objects.delete(key)) deleted.push(key);
    });
  return store;
}
