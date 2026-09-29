/**
 * Cloudflare R2 through its S3-compatible API, signed with AWS Signature Version 4 (region `auto`).
 * Credentials stay in this process; browsers only ever receive short-lived presigned GET URLs.
 * Missing configuration builds a store whose every call fails visibly instead of pretending to save.
 */
import { createHash, createHmac } from 'node:crypto';
import { Config, Effect, Layer, Option, Redacted } from 'effect';
import { ObjectStore, ObjectStoreError, type StoredObject } from '../object-store.ts';

export interface SigningKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amzDate = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const canonicalQuery = (url: URL) =>
  [...url.searchParams]
    .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
    .sort()
    .join('&');

function sign(key: SigningKey, date: string, canonicalRequest: string) {
  const day = date.slice(0, 8);
  const scope = `${day}/${key.region}/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretAccessKey}`, day), key.region), 's3'), 'aws4_request');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  return { credential: `${key.accessKeyId}/${scope}`, signature: createHmac('sha256', signingKey).update(stringToSign).digest('hex') };
}

/** Returns the request headers plus `authorization`; `headers` names must be lowercase. */
export function signRequest(input: {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly key: SigningKey;
  readonly now: Date;
}): Record<string, string> {
  const date = amzDate(input.now);
  const headers: Record<string, string> = { ...input.headers, host: input.url.host, 'x-amz-content-sha256': input.payloadHash, 'x-amz-date': date };
  const names = Object.keys(headers).sort();
  const canonical = [
    input.method,
    input.url.pathname,
    canonicalQuery(input.url),
    names.map(name => `${name}:${headers[name]!.trim()}\n`).join(''),
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const { credential, signature } = sign(input.key, date, canonical);
  const { host: _host, ...sent } = headers;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** Query-signed GET URL valid for `expiresSeconds`. */
export function presignUrl(input: { readonly url: URL; readonly key: SigningKey; readonly now: Date; readonly expiresSeconds: number }): string {
  const url = new URL(input.url);
  const date = amzDate(input.now);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', sign(input.key, date, '').credential);
  url.searchParams.set('X-Amz-Date', date);
  url.searchParams.set('X-Amz-Expires', String(input.expiresSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  const canonical = ['GET', url.pathname, canonicalQuery(url), `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  return `${url.origin}${url.pathname}?${canonicalQuery(url)}&X-Amz-Signature=${sign(input.key, date, canonical).signature}`;
}

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

function r2Store(config: R2Config) {
  const key: SigningKey = { accessKeyId: config.accessKeyId, secretAccessKey: Redacted.value(config.secretAccessKey), region: 'auto' };
  const objectUrl = (name: string) => new URL(`${config.endpoint.pathname.replace(/\/$/, '')}/${config.bucket}/${config.prefix}${name}`, config.endpoint);

  const request = (operation: Operation, name: string, method: string, body?: Uint8Array, extra: Record<string, string> = {}) =>
    Effect.tryPromise(signal => {
      const url = objectUrl(name);
      const payloadHash = extra['x-amz-meta-sha256'] ?? sha256Hex(body ?? '');
      const headers = signRequest({ method, url, headers: extra, payloadHash, key, now: new Date() });
      return fetch(url, { method, headers, body: body ?? null, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) });
    }).pipe(
      // A write whose response never arrived may still have landed; the caller reconciles with head.
      Effect.mapError(error => new ObjectStoreError({ operation, key: name, message: String(error.cause), ambiguous: method === 'PUT' })),
      Effect.filterOrFail(
        response => response.ok || (method !== 'PUT' && response.status === 404),
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
    presignGet: (name, ttlMs) => Effect.sync(() => presignUrl({ url: objectUrl(name), key, now: new Date(), expiresSeconds: Math.max(1, Math.floor(ttlMs / 1000)) })),
  });
}

const unconfigured = (operation: Operation, key: string) =>
  Effect.fail(new ObjectStoreError({ operation, key, message: 'R2 is not configured (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)', ambiguous: false }));

export const R2ObjectStoreLive = Layer.effect(
  ObjectStore,
  Effect.map(Config.option(r2Config), config =>
    Option.isSome(config)
      ? r2Store(config.value)
      : ObjectStore.of({
          put: key => unconfigured('put', key),
          head: key => unconfigured('head', key),
          get: key => unconfigured('get', key),
          presignGet: key => unconfigured('presign', key),
        }),
  ),
);
