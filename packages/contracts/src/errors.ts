/**
 * Error envelope shared by REST, SDKs and MCP: `code`, `message`, optional `request_id`,
 * `retryable`, and typed details. Domain code fails with these classes directly; the HTTP
 * API maps each one to the HTTP status in its annotation. Missing and unauthorized
 * resources may both surface as NotFound where revealing existence would leak data.
 */
import { HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';

const envelope = {
  message: Schema.String,
  request_id: Schema.optional(Schema.String),
};

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()('Unauthenticated', {
  code: Schema.tag('unauthenticated'),
  retryable: Schema.tag(false),
  ...envelope,
}, HttpApiSchema.annotations({ status: 401 })) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', {
  code: Schema.tag('forbidden'),
  retryable: Schema.tag(false),
  ...envelope,
  /** Scope the caller lacks, when naming it does not leak data. */
  required_scope: Schema.optional(Schema.String),
}, HttpApiSchema.annotations({ status: 403 })) {}

export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  code: Schema.tag('not_found'),
  retryable: Schema.tag(false),
  ...envelope,
}, HttpApiSchema.annotations({ status: 404 })) {}

/** Stale `expected_revision`; carries the current revision so the caller can rebase. */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()('RevisionConflict', {
  code: Schema.tag('revision_conflict'),
  retryable: Schema.tag(false),
  ...envelope,
  current_revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
}, HttpApiSchema.annotations({ status: 409 })) {}

/** Same idempotency key or chunk ID with different content. */
export class HashConflict extends Schema.TaggedError<HashConflict>()('HashConflict', {
  code: Schema.tag('hash_conflict'),
  retryable: Schema.tag(false),
  ...envelope,
  existing_sha256: Schema.String,
}, HttpApiSchema.annotations({ status: 409 })) {}

/** Dependency down, unselected policy/configuration, or overload; `retryable` says whether retrying can help. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', {
  code: Schema.tag('unavailable'),
  ...envelope,
  retryable: Schema.Boolean,
  retry_after_ms: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
}, HttpApiSchema.annotations({ status: 503 })) {}
