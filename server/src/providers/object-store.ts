/**
 * Private recording object storage (Cloudflare R2 through its S3 API in production).
 * Credentials stay server-side; browsers only ever receive short-lived signed GET URLs.
 * The media slice supplies the R2 layer; tests use `tests/support/object-store.ts`.
 */
import { Context, Data, type Effect } from 'effect';

export class ObjectStoreError extends Data.TaggedError('ObjectStoreError')<{
  readonly operation: 'put' | 'head' | 'get' | 'presign' | 'list' | 'delete';
  readonly key: string;
  readonly message: string;
  /** Unknown outcome (e.g. timeout after sending); callers reconcile with `head` before retrying. */
  readonly ambiguous: boolean;
  /** Storage credentials are absent: retrying cannot help until an operator configures them. */
  readonly unconfigured?: boolean;
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
  /** Up to one page (at most 1,000) of keys starting with `prefix`, in key order. */
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>, ObjectStoreError>;
  /** Idempotent: deleting a missing key succeeds. */
  readonly delete: (key: string) => Effect.Effect<void, ObjectStoreError>;
}

export class ObjectStore extends Context.Tag('sanctum/ObjectStore')<ObjectStore, ObjectStoreService>() {}

/** Mono PCM16 WAV file holding `parts` at `rate`, the format of every recording object. */
export const wavFile = (rate: number, parts: ReadonlyArray<Uint8Array>) => {
  const bytes = parts.reduce((total, part) => total + part.byteLength, 0);
  const header = Buffer.alloc(44);
  header.write('RIFFxxxxWAVEfmt ', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  // A plain copy: Buffer.slice/subarray share memory, which callers of the object store do not expect.
  return new Uint8Array(Buffer.concat([header, ...parts]));
};
