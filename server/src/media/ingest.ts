/**
 * Authenticated live-ingest WebSocket on `LISTENER_STREAM_PATH`, served by the same Effect Node HTTP
 * server as `/api/v1` (whose upgrade handling uses `ws`). The Origin, credentials and listener ownership
 * are checked before upgrading, so an unauthorized client never receives a socket. Inbound messages
 * pass through a bounded queue; overflow closes the socket and the client resumes from the watermark.
 */
import { HttpApiBuilder, HttpRouter, HttpServerRequest, HttpServerResponse, Socket } from '@effect/platform';
import type { SqlClient } from '@effect/sql';
import { type AccessScope, ClientControlMessage, LISTENER_STREAM_PATH, ListenerId, RejectedMessage, type ServerControlMessage } from '@sanctum/contracts';
import { Config, Deferred, Effect, Exit, Mailbox, Option, Schema } from 'effect';
import { Authenticator } from '../auth.ts';
import { type ListenerRow, ownedListener, startEpoch } from '../listeners.ts';
import type { SpeechToText } from '../providers/whisper.ts';
import { trackSocket } from './open-sockets.ts';
import { openLiveSession, reject, SessionRejected } from './session.ts';

/** Queued inbound messages per socket (at most ~1.2 MB of maximum-size frames). */
const INBOUND_LIMIT = 64;

const decodeControl = Schema.decodeUnknownOption(Schema.parseJson(ClientControlMessage));

interface Closing {
  readonly code: number;
  readonly reason: string;
}

/** Start handshake, then frames until `stop`, disconnect, rejection or fencing by a newer owner. */
const dialogue = (access: AccessScope, listener: ListenerRow, inbound: Mailbox.ReadonlyMailbox<string | Uint8Array>, send: (message: ServerControlMessage) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const first = yield* inbound.take.pipe(
      Effect.timeout('10 seconds'),
      Effect.catchTag('TimeoutException', () => reject('protocol_error', 'No start message')),
    );
    const start = typeof first === 'string' ? decodeControl(first) : Option.none();
    if (Option.isNone(start) || start.value._tag !== 'start' || start.value.listener_id !== listener.id) {
      return yield* reject('invalid_start', 'Expected a valid start message for this listener');
    }
    const verdict = yield* startEpoch(access, start.value);
    if (verdict._tag === 'rejected') return yield* new SessionRejected({ message: verdict });
    yield* send(verdict);
    if (start.value.archive_only) return { code: 1000, reason: 'registered' } satisfies Closing;
    const session = yield* openLiveSession({ access, listener, start: start.value, resume_from_sample: verdict.resume_from_sample, send });
    const loop = Effect.gen(function* () {
      for (;;) {
        const message = yield* inbound.take;
        if (typeof message !== 'string') {
          yield* session.frame(message);
          continue;
        }
        const control = decodeControl(message);
        if (Option.isNone(control) || control.value._tag !== 'stop') return yield* reject('protocol_error', 'Unexpected control message');
        yield* session.stop(control.value.reason);
        return { code: 1000, reason: 'stopped' } satisfies Closing;
      }
    });
    return yield* loop.pipe(
      Effect.raceFirst(session.fenced),
      Effect.catchTag('NoSuchElementException', () => Effect.succeed<Closing>({ code: 1000, reason: 'client disconnected' })),
    );
  });

const converse = (access: AccessScope, listener: ListenerRow, socket: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* socket.writer;
      const inbound = yield* Mailbox.make<string | Uint8Array>(INBOUND_LIMIT);
      const overflow = yield* Deferred.make<Closing, SessionRejected>();
      const deleted = new SessionRejected({ message: RejectedMessage.make({ reason: 'unauthorized', message: 'This workspace was deleted' }) });
      yield* trackSocket(access.workspace_id, () => Deferred.unsafeDone(overflow, Exit.fail(deleted)));
      const ended = yield* Deferred.make<void>();
      // The writer waits for an open socket, so writes race the peer's disconnect instead of hanging.
      const write = (chunk: string | Socket.CloseEvent) => writer(chunk).pipe(Effect.ignore, Effect.raceFirst(Deferred.await(ended)));
      const send = (message: ServerControlMessage) => write(JSON.stringify(message));
      yield* socket
        .runRaw(data => {
          if (!inbound.unsafeOffer(data)) Deferred.unsafeDone(overflow, Exit.succeed({ code: 1013, reason: 'server backlog full; reconnect to resume' }));
        })
        .pipe(Effect.ignore, Effect.ensuring(Effect.zipRight(inbound.end, Deferred.succeed(ended, undefined))), Effect.forkScoped);
      const closing = yield* dialogue(access, listener, inbound, send).pipe(
        Effect.raceFirst(Deferred.await(overflow)),
        Effect.catchTag('SessionRejected', ({ message }) => Effect.as(send(message), { code: 1008, reason: message.reason })),
        Effect.catchAll(error => Effect.as(Effect.logError('Live session failed', error), { code: 1011, reason: 'internal error' })),
      );
      yield* write(new Socket.CloseEvent(closing.code, closing.reason));
    }),
  );

const sameHost = (origin: string, host: string | undefined) => URL.canParse(origin) && new URL(origin).host === host;

const upgrade = (allowedOrigins: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const listener_id = Schema.decodeUnknownOption(ListenerId)((yield* HttpRouter.params).listener_id);
    if (Option.isNone(listener_id)) return HttpServerResponse.empty({ status: 404 });
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin) && !sameHost(origin, request.headers.host)) return HttpServerResponse.empty({ status: 403 });
    const authenticator = yield* Authenticator;
    const access = yield* authenticator.authenticate(request);
    const listener = yield* ownedListener(access, listener_id.value);
    yield* converse(access, listener, yield* request.upgrade);
    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchTags({
      Unauthenticated: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      Forbidden: () => Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      NotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      SqlError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    }),
  );

/** Registers the upgrade route on the API router; `SANCTUM_ALLOWED_ORIGINS` adds cross-origin web apps. */
export const ListenerStreamLive = HttpApiBuilder.Router.use(router =>
  Effect.gen(function* () {
    const allowedOrigins = yield* Config.array(Config.string(), 'SANCTUM_ALLOWED_ORIGINS').pipe(Config.withDefault([]));
    const context = yield* Effect.context<SqlClient.SqlClient | Authenticator | SpeechToText>();
    yield* router.get(LISTENER_STREAM_PATH, Effect.provide(upgrade(allowedOrigins), context));
  }),
);
