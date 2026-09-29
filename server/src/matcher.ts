/**
 * Semantic needs/offers matching (plan section 08, T04): versioned profile embeddings in MySQL
 * and exact cosine top-k in bounded Float32Array batches, scoped to one workspace before any
 * vector is loaded. Exact O(N x dimensions) scan, not an ANN index; see
 * scripts/benchmark-matching.ts for its measured cost.
 */
import { endianness } from 'node:os';
import { SqlClient, SqlSchema, type SqlError } from '@effect/sql';
import { type AccessScope, NotFound, ProfileId, RevisionConflict } from '@sanctum/contracts';
import { Effect, Schema } from 'effect';
import { ER_NO_REFERENCED_ROW, mysqlErrno } from './db.ts';

/** Rows per ranking batch; matches `candidate_batch_size` in benchmarks/workload.json. */
export const MATCH_BATCH_SIZE = 1_000;
/** `VARBINARY(16384)` holds at most 4,096 float32 values. */
const MAX_DIMENSION = 4_096;
const MAX_TOP_K = 100;

// Stored bytes are little-endian float32 and are viewed without a byte swap.
if (endianness() !== 'LE') throw new Error('profile embeddings are little-endian float32; this host is big-endian');

export type EmbeddingKind = 'profile' | 'needs' | 'offers';

export class InvalidEmbedding extends Schema.TaggedError<InvalidEmbedding>()('InvalidEmbedding', { message: Schema.String }) {}

/** Unit-length float32 copy; empty, oversized, non-finite and zero vectors are rejected. */
export function normalizeEmbedding(values: ArrayLike<number>): Float32Array | InvalidEmbedding {
  if (values.length === 0 || values.length > MAX_DIMENSION) return new InvalidEmbedding({ message: `dimension must be 1..${MAX_DIMENSION}, got ${values.length}` });
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]! * values[i]!;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm)) return new InvalidEmbedding({ message: 'embedding contains a non-finite value' });
  if (norm === 0) return new InvalidEmbedding({ message: 'embedding is the zero vector' });
  const unit = Float32Array.from(values, value => value / norm);
  return unit.some(value => value !== 0) ? unit : new InvalidEmbedding({ message: 'embedding underflows float32' });
}

/** Dot product of `query` with the vector starting at `offset` in `vectors`; cosine for unit vectors. */
export function dot(query: Float32Array, vectors: Float32Array, offset: number): number {
  let sum = 0;
  for (let i = 0; i < query.length; i++) sum += query[i]! * vectors[offset + i]!;
  return sum;
}

/**
 * Best `k` scores seen so far, highest first. Offers arrive in ascending ID order, so an
 * equal score keeps the lower ID ahead.
 * ponytail: sorted-array insertion, O(k) per accepted offer with k <= 100; use a heap if k grows.
 */
export class TopK {
  readonly ids: string[] = [];
  readonly scores: number[] = [];
  readonly k: number;

  constructor(k: number) {
    this.k = k;
  }

  offer(id: string, score: number): void {
    if (this.scores.length === this.k && score <= this.scores[this.k - 1]!) return;
    let at = this.scores.length;
    while (at > 0 && score > this.scores[at - 1]!) at--;
    this.ids.splice(at, 0, id);
    this.scores.splice(at, 0, score);
    if (this.ids.length > this.k) {
      this.ids.pop();
      this.scores.pop();
    }
  }
}

/**
 * mysql2 returns Buffers sliced from a shared packet buffer: an aligned one is viewed in
 * place, an unaligned one is copied (`Buffer#slice` would not copy).
 */
const float32View = (bytes: Uint8Array) =>
  bytes.byteOffset % 4 === 0 ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) : new Float32Array(new Uint8Array(bytes).buffer);

const EmbeddingRow = Schema.Struct({ profile_id: ProfileId, dimension: Schema.Number, embedding: Schema.Uint8ArrayFromSelf });
const QueryRow = Schema.Struct({ ...EmbeddingRow.fields, model: Schema.String });

export interface StoreEmbeddingInput {
  readonly profile_id: ProfileId;
  readonly kind: EmbeddingKind;
  /** Embedding model ID; vectors from different models are never compared. */
  readonly model: string;
  readonly vector: ArrayLike<number>;
  /** Profile revision the vector was generated from; an older revision never replaces a newer one. */
  readonly source_revision: number;
}

const writeEmbedding = (sql: SqlClient.SqlClient, access: AccessScope, input: StoreEmbeddingInput, unit: Float32Array) =>
  Effect.gen(function* () {
    const [known] = yield* sql<{ dimension: number }>`SELECT dimension FROM profile_embeddings
      WHERE workspace_id = ${access.workspace_id} AND model = ${input.model} LIMIT 1`;
    if (known && known.dimension !== unit.length) {
      return yield* new InvalidEmbedding({ message: `model ${input.model} uses dimension ${known.dimension}, got ${unit.length}` });
    }
    const bytes = Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength);
    // One atomic upsert without locking reads: an older revision leaves the row unchanged.
    yield* sql`INSERT INTO profile_embeddings (workspace_id, profile_id, kind, model, dimension, embedding, source_revision, created_at)
      VALUES (${access.workspace_id}, ${input.profile_id}, ${input.kind}, ${input.model}, ${unit.length}, ${bytes}, ${input.source_revision}, UTC_TIMESTAMP(6)) AS incoming
      ON DUPLICATE KEY UPDATE
        embedding = IF(incoming.source_revision >= profile_embeddings.source_revision, incoming.embedding, profile_embeddings.embedding),
        created_at = IF(incoming.source_revision >= profile_embeddings.source_revision, incoming.created_at, profile_embeddings.created_at),
        source_revision = GREATEST(incoming.source_revision, profile_embeddings.source_revision)`;
    const [stored] = yield* sql<{ source_revision: number }>`SELECT source_revision FROM profile_embeddings
      WHERE workspace_id = ${access.workspace_id} AND profile_id = ${input.profile_id} AND kind = ${input.kind} AND model = ${input.model}`;
    if (stored && stored.source_revision > input.source_revision) {
      return yield* new RevisionConflict({ message: 'a newer profile revision is already embedded', current_revision: stored.source_revision });
    }
  });

/** Stores the normalized vector for one profile/kind/model; a profile outside the workspace is NotFound. */
export const storeEmbedding = (access: AccessScope, input: StoreEmbeddingInput) =>
  Effect.gen(function* () {
    const unit = normalizeEmbedding(input.vector);
    if (unit instanceof InvalidEmbedding) return yield* unit;
    return yield* writeEmbedding(yield* SqlClient.SqlClient, access, input, unit);
  }).pipe(
    Effect.catchIf(
      (error): error is SqlError.SqlError => error._tag === 'SqlError' && mysqlErrno(error) === ER_NO_REFERENCED_ROW,
      () => new NotFound({ message: 'profile not found' }),
    ),
  );

export interface MatchQuery {
  readonly profile_id: ProfileId;
  /** `needs` ranks other profiles' offers against this profile's needs, and vice versa. */
  readonly kind: 'needs' | 'offers';
  readonly top_k: number;
}

/**
 * Exact cosine top-k within the caller's workspace, same model and dimension as the query
 * vector, excluding the query profile. A missing or foreign profile/embedding is NotFound;
 * database failures are defects, as in the other read contracts.
 */
export const rankMatches = (access: AccessScope, query: MatchQuery) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const source = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: QueryRow,
      execute: () => sql`SELECT profile_id, model, dimension, embedding FROM profile_embeddings
        WHERE workspace_id = ${access.workspace_id} AND profile_id = ${query.profile_id} AND kind = ${query.kind}
        ORDER BY created_at DESC LIMIT 1`,
    })(undefined).pipe(Effect.orDie);
    if (source._tag === 'None') return yield* new NotFound({ message: 'profile embedding not found' });
    const k = Math.min(Math.floor(query.top_k), MAX_TOP_K);
    if (!(k >= 1)) return [];
    const target = query.kind === 'needs' ? 'offers' : 'needs';
    const vector = float32View(source.value.embedding);
    const best = new TopK(k);
    const page = SqlSchema.findAll({
      Request: Schema.String,
      Result: EmbeddingRow,
      execute: after => sql`SELECT profile_id, dimension, embedding FROM profile_embeddings
        WHERE workspace_id = ${access.workspace_id} AND kind = ${target} AND model = ${source.value.model} AND profile_id > ${after}
        ORDER BY profile_id LIMIT ${MATCH_BATCH_SIZE}`,
    });
    let after = '';
    for (;;) {
      const rows = yield* Effect.orDie(page(after));
      for (const row of rows) {
        if (row.profile_id !== query.profile_id && row.dimension === vector.length) best.offer(row.profile_id, dot(vector, float32View(row.embedding), 0));
      }
      if (rows.length < MATCH_BATCH_SIZE) break;
      after = rows.at(-1)!.profile_id;
    }
    return best.ids.map((id, i) => ({ profile_id: ProfileId.make(id), score: best.scores[i]! }));
  });
