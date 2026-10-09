/**
 * Cloudflare R2 through its S3-compatible API, signed with AWS Signature Version 4 (`aws4fetch`, region `auto`).
 * Credentials stay in this process; browsers only ever receive short-lived presigned GET URLs.
 * Missing configuration builds a store whose every call fails visibly instead of pretending to save.
 */
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { Config, Effect, Layer, Option, Redacted } from 'effect';
import { ObjectStore, ObjectStoreError, type StoredObject } from './object-store.ts';

const r2Config = Config.all({
  endpoint: Config.url('R2_ENDPOINT'),
  bucket: Config.string('R2_BUCKET'),
  accessKeyId: Config.string('R2_ACCESS_KEY_ID'),
  secretAccessKey: Config.redacted('R2_SECRET_ACCESS_KEY'),
  prefix: Config.string('R2_PREFIX').pipe(Config.withDefault('')),
  timeoutMs: Config.integer('R2_TIMEOUT_MS').pipe(Config.withDefault(30_000)),
});
type R2Config = Config.Config.Success<typeof r2Config>;

type Operation = ObjectStoreError['operation'];

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function r2Store(config: R2Config) {
  // Retries stay with the caller: an unanswered PUT is ambiguous and is reconciled with `head`, never blindly resent.
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: Redacted.value(config.secretAccessKey), service: 's3', region: 'auto', retries: 0 });
  const bucketPath = `${config.endpoint.pathname.replace(/\/$/, '')}/${config.bucket}`;
  const objectUrl = (name: string) => new URL(`${bucketPath}/${config.prefix}${name}`, config.endpoint);

  const request = (operation: Operation, name: string, method: string, body?: Uint8Array, extra: Record<string, string> = {}, url = objectUrl(name)) =>
    Effect.tryPromise(signal =>
      client.fetch(url, {
        method,
        // Sign the actual bytes so R2 rejects a body altered in transit.
        headers: body === undefined ? extra : { ...extra, 'x-amz-content-sha256': createHash('sha256').update(body).digest('hex') },
        body: body ?? null,
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      }),
    ).pipe(
      // A write whose response never arrived may still have landed; the caller reconciles with head.
      Effect.mapError(error => new ObjectStoreError({ operation, key: name, message: String(error.cause), ambiguous: method === 'PUT' })),
      Effect.filterOrFail(
        // A missing object is an answer for head and get; for list and delete a 404 means a missing bucket.
        response => response.ok || ((operation === 'head' || operation === 'get') && response.status === 404),
        response => new ObjectStoreError({ operation, key: name, message: `R2 responded ${response.status}`, ambiguous: method === 'PUT' && response.status >= 500 }),
      ),
    );

  return ObjectStore.of({
    put: (name, body, meta) =>
      request('put', name, 'PUT', body, { 'content-type': meta.contentType, 'x-amz-meta-sha256': meta.sha256 }).pipe(
        Effect.as({ key: name, byte_length: body.byteLength, sha256: meta.sha256 }),
      ),
    head: name =>
      request('head', name, 'HEAD').pipe(
        Effect.map((response): StoredObject | null =>
          response.status === 404
            ? null
            : { key: name, byte_length: Number(response.headers.get('content-length') ?? 0), sha256: response.headers.get('x-amz-meta-sha256') ?? '' },
        ),
      ),
    get: name =>
      request('get', name, 'GET').pipe(
        Effect.filterOrFail(
          response => response.status !== 404,
          () => new ObjectStoreError({ operation: 'get', key: name, message: 'not found', ambiguous: false }),
        ),
        Effect.flatMap(response => Effect.tryPromise(() => response.arrayBuffer())),
        Effect.mapError(error => (error._tag === 'UnknownException' ? new ObjectStoreError({ operation: 'get', key: name, message: String(error.cause), ambiguous: false }) : error)),
        Effect.map(buffer => new Uint8Array(buffer)),
      ),
    presignGet: (name, ttlMs) =>
      Effect.tryPromise(() => {
        const url = objectUrl(name);
        url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.floor(ttlMs / 1000))));
        return client.sign(url, { method: 'GET', aws: { signQuery: true } });
      }).pipe(
        Effect.map(request => request.url),
        Effect.mapError(error => new ObjectStoreError({ operation: 'presign', key: name, message: String(error.cause), ambiguous: false })),
      ),
    list: prefix => {
      const url = new URL(bucketPath, config.endpoint);
      url.search = new URLSearchParams({ 'list-type': '2', prefix: `${config.prefix}${prefix}`, 'max-keys': '1000' }).toString();
      return request('list', prefix, 'GET', undefined, {}, url).pipe(
        Effect.flatMap(response => Effect.tryPromise(() => response.text())),
        Effect.mapError(error => (error._tag === 'UnknownException' ? new ObjectStoreError({ operation: 'list', key: prefix, message: String(error.cause), ambiguous: false }) : error)),
        // ListObjectsV2 XML: each <Key> is XML-escaped and carries the configured prefix.
        Effect.map(xml => [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map(match => match[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!).slice(config.prefix.length))),
      );
    },
    delete: name => Effect.asVoid(request('delete', name, 'DELETE')),
  });
}

const unconfigured = (operation: Operation) => (key: string) =>
  Effect.fail(new ObjectStoreError({ operation, key, message: 'R2 is not configured (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)', ambiguous: false, unconfigured: true }));

export const R2ObjectStoreLive = Layer.effect(
  ObjectStore,
  Effect.map(Config.option(r2Config), config =>
    Option.isSome(config)
      ? r2Store(config.value)
      : ObjectStore.of({
        put: unconfigured('put'),
        head: unconfigured('head'),
        get: unconfigured('get'),
        presignGet: unconfigured('presign'),
        list: unconfigured('list'),
        delete: unconfigured('delete'),
      }),
  ),
);
