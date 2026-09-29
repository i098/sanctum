/**
 * Private recording object storage (Cloudflare R2 through its S3 API in production).
 * Credentials stay server-side; browsers only ever receive short-lived signed GET URLs.
 * The media slice supplies the R2 layer; tests use `tests/support/object-store.ts`.
 */
import { Context, Data, type Effect } from 'effect';

export class ObjectStoreError extends Data.TaggedError('ObjectStoreError')<{
  readonly operation: 'put' | 'head' | 'get' | 'presign';
  readonly key: string;
  readonly message: string;
  /** Unknown outcome (e.g. timeout after sending); callers reconcile with `head` before retrying. */
  readonly ambiguous: boolean;
}> {}

export interface StoredObject {
  readonly key: string;
  readonly byte_length: number;
  /** Lowercase hex SHA-256 recorded as object metadata at upload. */
  readonly sha256: string;
}

interface ObjectStoreService {
  readonly put: (key: string, body: Uint8Array, meta: { readonly sha256: string; readonly contentType: string }) => Effect.Effect<StoredObject, ObjectStoreError>;
  readonly head: (key: string) => Effect.Effect<StoredObject | null, ObjectStoreError>;
  readonly get: (key: string) => Effect.Effect<Uint8Array, ObjectStoreError>;
  /** Signed GET URL; issue only after a fresh access check and never for longer than the configured TTL. */
  readonly presignGet: (key: string, ttlMs: number) => Effect.Effect<string, ObjectStoreError>;
}

export class ObjectStore extends Context.Tag('sanctum/ObjectStore')<ObjectStore, ObjectStoreService>() {}
