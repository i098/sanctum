/** In-memory R2 stand-in for tests: records every call and can inject failures per operation. */
import { Effect, Layer } from 'effect';
import { ObjectStore, ObjectStoreError, type StoredObject } from '../../src/object-store.ts';

type Operation = ObjectStoreError['operation'];

export interface MemoryObjectStore {
  readonly layer: Layer.Layer<ObjectStore>;
  readonly objects: Map<string, { readonly body: Uint8Array; readonly sha256: string; readonly contentType: string }>;
  /** Makes the next call of `operation` fail; `ambiguous` simulates a timeout after the write landed. */
  failNext(operation: Operation, options?: { readonly ambiguous?: boolean }): void;
  /** Wall clock used to sign and verify URLs, replaceable for expiry tests. */
  now: () => number;
  verifySignedUrl(url: string): string | null;
}

export function memoryObjectStore(): MemoryObjectStore {
  const objects: MemoryObjectStore['objects'] = new Map();
  const failures = new Map<Operation, boolean>();
  const store: MemoryObjectStore = {
    objects,
    failNext: (operation, options) => void failures.set(operation, options?.ambiguous ?? false),
    now: () => Date.now(),
    verifySignedUrl: url => {
      const parsed = new URL(url);
      return Number(parsed.searchParams.get('expires')) > store.now() ? decodeURIComponent(parsed.pathname.slice(1)) : null;
    },
    layer: Layer.sync(ObjectStore, () => ({ put, head, get, presignGet })),
  };
  const attempt = <A>(operation: Operation, key: string, run: () => A) =>
    Effect.suspend(() => {
      const ambiguous = failures.get(operation);
      failures.delete(operation);
      if (ambiguous === undefined) return Effect.succeed(run());
      if (ambiguous) run();
      return Effect.fail(new ObjectStoreError({ operation, key, ambiguous, message: 'injected failure' }));
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
  return store;
}
