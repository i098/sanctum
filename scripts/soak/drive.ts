/**
 * Real-time soak driver: plays canonical mono PCM16 WAV audio into a Sanctum API as a live listener, at
 * real speed, the way the website's capture tab would. It registers a listener, heartbeats every 15 s,
 * streams 100 ms PCM frames over the listener WebSocket, uploads 30 s archive chunks, reconnects and
 * resumes from the server watermark, and shares each meeting with its workspace so other agents can query.
 *
 * `--manifest` plays the corpus built by build-corpus.ts: each meeting's WAV at its `start_s`, silence in the gaps,
 * and at run start the driver writes the run's T0 (when sample 0 was captured) into the manifest's `t0` slot: `epoch_s` in epoch seconds and `tz` 'UTC'.
 * Every new epoch is stamped with the real time, so an outage delays all later audio. The state file therefore records
 * `actual_at`, the real event time of each manifest fact as streamed (not `t0 + at_s`), and `outages`, the
 * cumulative delay behind T0 at each epoch that began after T0.
 *
 * Stops, in every case with a final chunk flush and share pass, on: end of audio, `--max-seconds`, a kill
 * switch (the `--kill-file` appearing, or SIGINT/SIGTERM/SIGUSR2), the cost hard stop, or a fatal rejection.
 * Exit codes: 0 finished or killed, 1 fatal, 3 cost hard stop.
 *
 * Cost: the hard stop compares `costUsd` of measured units (speech seconds sent, wall seconds run, chunk
 * PUTs) plus `--baseline-usd` (spent building the audio) with `--max-usd`. Extraction is priced at its
 * ceiling per speech minute because the API does not meter it; see RATES.
 *
 * Needs `SANCTUM_SOAK_TOKEN`: a token of the soak workspace owner (not an enrolled device) holding `capture:ingest`,
 * `context:read` and `context:write`. One principal registers the listener, streams and shares, because only a
 * meeting's owner with `context:write` can share it.
 * Usage: node scripts/soak/drive.ts --base-url https://host (--audio day.wav | --manifest corpus/manifest.json) --state-dir <dir>
 *          [--kill-file <path>] [--max-usd 15] [--baseline-usd 0] [--max-seconds N] [--name soak-driver]
 *
 * The state file `<state-dir>/driver.json` (mode 600) holds the listener, the acknowledged sample offset,
 * the cumulative units, counters, `actual_at` and `outages`; a restart resumes from it in a new epoch. Audio acknowledged but not
 * yet archived when the process dies (under one chunk) is not archived.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { encodePcmFrame } from '@sanctum/contracts';
import { manifestSource, type Source, wavSource } from './source.ts';
import { isSpeech, wavFile } from './wav.ts';

const HEARTBEAT_MS = 15_000;
const FRAME_MS = 100;
const CHUNK_SECONDS = 30;
/** After a reconnect the driver catches up to its real-time schedule at no more than this multiple of real speed. */
const CATCH_UP = 4;
const MAX_BUFFERED_BYTES = 512 * 1024;
const SHARE_MS = 60_000;
const STATUS_MS = 30_000;

/** Prices fetched 2026-10-14 (see README.md); extraction is a ceiling, not a measurement. */
const RATES = {
  whisper_per_audio_min: 0.0005,
  extraction_per_audio_min: 8 / 960,
  container_per_s: 0.7 / 86_400,
  r2_put: 4.5e-6,
};

/** `speech_seconds` counts audio sent above the server's -56 dBFS gate. */
export interface Units { speech_seconds: number; run_seconds: number; chunk_puts: number }

export const costUsd = (units: Units, baselineUsd = 0) =>
  baselineUsd +
  (units.speech_seconds / 60) * (RATES.whisper_per_audio_min + RATES.extraction_per_audio_min) +
  units.run_seconds * RATES.container_per_s +
  units.chunk_puts * RATES.r2_put;

interface Counters {
  reconnects: number;
  epochs: number;
  heartbeats: number;
  heartbeat_failures: number;
  chunks_ok: number;
  chunks_rejected: number;
  shares: number;
  share_failures: number;
  transcripts: number;
  degraded: number;
  /** Speech output must stay zero: the soak scripts never address Sanctum. */
  speech_chunks: number;
}

interface Outage {
  /** Position in the audio, in seconds from T0, where the epoch began. */
  readonly at_s: number;
  readonly resumed_at: string;
  /** Seconds the audio at `at_s` plays behind its nominal time `t0 + at_s`; cumulative over all outages. */
  readonly lag_s: number;
  readonly reason: Epoch['reason'];
}

interface State {
  listener_id: string | null;
  /** Run start: epoch seconds when sample 0 was captured. Written to the manifest's `t0.epoch_s`. */
  t0: number | null;
  offset: number;
  units: Units;
  counters: Counters;
  /** Manifest fact id -> the real time its first sample was captured, as last streamed. */
  actual_at: Record<string, string>;
  outages: Outage[];
}

interface Clock { sample_rate: number; channels: 1; encoding: 'pcm_s16le'; sample_start: number; captured_at: string; timezone: 'UTC' }

interface Epoch {
  readonly id: string;
  readonly clock: Clock;
  readonly reason: 'start' | 'resume' | 'stream_restart';
  readonly wall_base: number;
  sequence: number;
  next_chunk: number;
}

interface ChunkJob { readonly epoch: Epoch; readonly chunk_id: string; readonly sequence: number; readonly sample_start: number; readonly sample_count: number }

interface PlantedFact { readonly id: string; readonly at_s: number }

/** When `sample` was captured, on the epoch's clock. */
export const captureTime = (clock: Pick<Clock, 'sample_rate' | 'sample_start' | 'captured_at'>, sample: number) =>
  new Date(Date.parse(clock.captured_at) + ((sample - clock.sample_start) / clock.sample_rate) * 1000).toISOString();

/** Real capture time of each fact whose first sample lies in `[start, start + count)`. */
export function factTimes(clock: Pick<Clock, 'sample_rate' | 'sample_start' | 'captured_at'>, facts: ReadonlyArray<PlantedFact>, start: number, count: number) {
  const times: Record<string, string> = {};
  for (const { id, at_s } of facts) {
    const sample = Math.round(at_s * clock.sample_rate);
    if (sample >= start && sample < start + count) times[id] = captureTime(clock, sample);
  }
  return times;
}

/** A safety limit or duration from the command line: a finite number of at least zero. */
export function parseLimit(name: string, text: string) {
  const value = text.trim() === '' ? Number.NaN : Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a number of at least 0, got '${text}'`);
  return value;
}

interface Rejection { readonly reason: string; readonly message: string }
type Handshake = { readonly _tag: 'accepted'; readonly resume_from_sample: number } | ({ readonly _tag: 'rejected' } & Rejection);
type Ended = 'closed' | 'stopped' | 'finished';

interface Link {
  readonly socket: WebSocket;
  readonly opened: Deferred<void>;
  readonly handshake: Deferred<Handshake>;
  readonly closed: Deferred<void>;
  rejected: Rejection | undefined;
}

interface DriverOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** One canonical WAV, or null when `manifest` names the corpus. */
  readonly audio: string | null;
  /** Corpus `manifest.json`: its meetings play at their `start_s`, and the driver fills its `t0` at run start. */
  readonly manifest: string | null;
  readonly stateDir: string;
  readonly killFile: string;
  readonly maxUsd: number;
  readonly baselineUsd: number;
  readonly maxSeconds: number | null;
  readonly name: string;
}

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Deferred<T> { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (reason: Error) => void }

/** `Promise.withResolvers` without needing the es2024 lib. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => ((resolve = done), (reject = fail)));
  return { promise, resolve, reject };
}

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

const freshState = (): State => ({
  listener_id: null,
  t0: null,
  offset: 0,
  units: { speech_seconds: 0, run_seconds: 0, chunk_puts: 0 },
  counters: { reconnects: 0, epochs: 0, heartbeats: 0, heartbeat_failures: 0, chunks_ok: 0, chunks_rejected: 0, shares: 0, share_failures: 0, transcripts: 0, degraded: 0, speech_chunks: 0 },
  actual_at: {},
  outages: [],
});

class SoakDriver {
  private readonly rate: number;
  private readonly frameSamples: number;
  private readonly chunkSamples: number;
  private readonly end: number;
  private readonly stateFile: string;
  private readonly wake = new AbortController();
  private readonly queue: ChunkJob[] = [];
  private stopReason: string | null = null;
  private exitCode = 0;
  private generation = 0;
  private epoch: Epoch | null = null;
  private epochsThisRun = 0;
  private position: number;

  private readonly options: DriverOptions;
  private readonly state: State;
  private readonly source: Source;
  private readonly facts: ReadonlyArray<PlantedFact>;

  constructor(options: DriverOptions, state: State, source: Source, facts: ReadonlyArray<PlantedFact>) {
    this.options = options;
    this.state = state;
    this.source = source;
    this.facts = facts;
    this.rate = source.rate;
    this.frameSamples = (this.rate * FRAME_MS) / 1000;
    this.chunkSamples = this.rate * CHUNK_SECONDS;
    this.position = state.offset;
    this.end = options.maxSeconds === null ? source.samples : Math.min(source.samples, state.offset + Math.round(options.maxSeconds * this.rate));
    this.stateFile = join(options.stateDir, 'driver.json');
  }

  private get cost() {
    return costUsd(this.state.units, this.options.baselineUsd);
  }

  stop(reason: string, code = 0) {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.exitCode = code;
    log('stopping', { reason });
    this.wake.abort();
  }

  /** Resolves after `ms`, or at once when the driver stops. */
  private sleep(ms: number) {
    return delay(ms, undefined, { signal: this.wake.signal }).catch(() => undefined);
  }

  private save() {
    const temp = `${this.stateFile}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const raw = body instanceof Uint8Array;
    const response = await fetch(new URL(path, this.options.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new ApiError(response.status, `${method} ${path} -> ${response.status} ${text.slice(0, 200)}`);
    return text === '' ? null : JSON.parse(text);
  }

  private readSamples(start: number, count: number) {
    return this.source.read(start, count);
  }

  // --- listener lease -------------------------------------------------------------------------------------

  private async heartbeat() {
    try {
      const receipt = await this.call('POST', `/api/v1/listeners/${this.state.listener_id}/heartbeat`, {
        lease_generation: this.generation,
        state: this.epoch === null ? 'starting' : 'listening',
        epoch_id: this.epoch?.id ?? null,
        buffered_chunks: this.queue.length,
        storage_bytes_free: null,
      });
      this.generation = receipt.lease_generation;
      this.state.counters.heartbeats++;
      if (!receipt.owner) log('heartbeat_not_owner', { generation: this.generation });
      return true;
    } catch (error) {
      this.state.counters.heartbeat_failures++;
      log('heartbeat_failed', { error: String(error) });
      return false;
    }
  }

  private async heartbeatLoop() {
    while (this.stopReason === null) {
      await this.sleep(HEARTBEAT_MS);
      if (this.stopReason === null) await this.heartbeat();
    }
  }

  // --- archive chunks ---------------------------------------------------------------------------------------

  private enqueueChunk(epoch: Epoch, start: number, count: number) {
    this.queue.push({ epoch, chunk_id: randomUUID(), sequence: epoch.next_chunk++, sample_start: start, sample_count: count });
  }

  private chunkStart(epoch: Epoch) {
    return epoch.clock.sample_start + epoch.next_chunk * this.chunkSamples;
  }

  /** Queues every chunk of `epoch` that ends at or before `upTo`; `partial` also queues the rest. */
  private flushChunks(epoch: Epoch, upTo: number, partial = false) {
    while (this.chunkStart(epoch) + this.chunkSamples <= upTo) this.enqueueChunk(epoch, this.chunkStart(epoch), this.chunkSamples);
    const start = this.chunkStart(epoch);
    if (partial && upTo > start) this.enqueueChunk(epoch, start, upTo - start);
  }

  private manifestFor(job: ChunkJob, body: Uint8Array) {
    const { epoch } = job;
    return {
      chunk_id: job.chunk_id,
      listener_id: this.state.listener_id,
      epoch_id: epoch.id,
      track: 0,
      sequence: job.sequence,
      sample_start: job.sample_start,
      sample_count: job.sample_count,
      sample_rate: this.rate,
      captured_at: captureTime(epoch.clock, job.sample_start),
      byte_length: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  /** Uploads one chunk, retrying transient failures; a definitive refusal is counted and dropped. */
  private async putChunk(job: ChunkJob) {
    const body = wavFile(await this.readSamples(job.sample_start, job.sample_count), this.rate);
    const manifest = JSON.stringify(this.manifestFor(job, body));
    for (let attempt = 1; ; attempt++) {
      this.state.units.chunk_puts++;
      try {
        await this.call('PUT', `/api/v1/listeners/${this.state.listener_id}/chunks/${job.chunk_id}`, body, { 'content-type': 'audio/wav', 'x-sanctum-manifest': manifest });
        this.state.counters.chunks_ok++;
        return;
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500;
        if (status < 500 && ![408, 425, 429].includes(status)) {
          this.state.counters.chunks_rejected++;
          log('chunk_rejected', { sequence: job.sequence, sample_start: job.sample_start, error: String(error) });
          return;
        }
        log('chunk_retry', { sequence: job.sequence, attempt, error: String(error) });
        // After a stop, a few attempts only: the process is leaving.
        if (this.stopReason !== null && attempt >= 3) return;
        await delay(Math.min(30_000, 500 * 2 ** attempt));
      }
    }
  }

  /** Uploads queued chunks until `streamed` settles and the queue is empty. */
  private async uploadLoop(streamed: Promise<void>) {
    let draining = false;
    void streamed.then(() => (draining = true));
    for (;;) {
      const job = this.queue[0];
      if (job === undefined && draining) return;
      if (job === undefined) await delay(500);
      else {
        await this.putChunk(job);
        this.queue.shift();
      }
    }
  }

  // --- live stream ------------------------------------------------------------------------------------------

  /** T0 is when sample 0 was captured, in epoch seconds. Each epoch is stamped with the real time, so after an outage a fact's event time is `state.actual_at`, not `t0 + at_s`. */
  private setT0(t0: number) {
    this.state.t0 = t0;
    const { manifest } = this.options;
    if (manifest === null) return;
    const temp = `${manifest}.tmp`;
    const current = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(temp, `${JSON.stringify({ ...current, t0: { ...current.t0, epoch_s: t0, tz: 'UTC' } }, null, 2)}\n`);
    renameSync(temp, manifest);
    log('t0_set', { t0, manifest });
  }

  private newEpoch(): Epoch {
    const now = Date.now();
    this.state.counters.epochs++;
    const afterT0 = this.state.t0 !== null;
    if (this.state.t0 === null) this.setT0((now - (this.position / this.rate) * 1000) / 1000);
    const reason = this.epochsThisRun++ > 0 ? 'stream_restart' : this.state.offset > 0 ? 'resume' : 'start';
    if (afterT0) {
      const nominal = this.state.t0! * 1000 + (this.position / this.rate) * 1000;
      this.state.outages.push({ at_s: this.position / this.rate, resumed_at: new Date(now).toISOString(), lag_s: (now - nominal) / 1000, reason });
    }
    this.save();
    return {
      id: randomUUID(),
      clock: { sample_rate: this.rate, channels: 1, encoding: 'pcm_s16le', sample_start: this.position, captured_at: new Date(now).toISOString(), timezone: 'UTC' },
      reason,
      wall_base: now,
      sequence: 0,
      next_chunk: 0,
    };
  }

  private onMessage(link: Link, data: unknown) {
    const message = JSON.parse(String(data));
    const { counters } = this.state;
    switch (message._tag) {
      case 'accepted':
        return link.handshake.resolve(message);
      case 'rejected':
        link.rejected = message;
        return link.handshake.resolve(message);
      case 'ack':
        this.state.offset = Math.max(this.state.offset, message.sample_end);
        return;
      case 'transcript':
        counters.transcripts++;
        return;
      case 'degraded':
        counters.degraded++;
        return log('degraded', message);
      case 'speech_chunk':
        counters.speech_chunks++;
        return log('speech_output_violation', { generation: message.generation });
    }
  }

  private connect(): Link {
    const url = new URL(`/api/v1/listeners/${this.state.listener_id}/stream`, this.options.baseUrl.replace(/^http/, 'ws'));
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.options.token}` } } as unknown as string[]);
    socket.binaryType = 'arraybuffer';
    const link: Link = { socket, opened: deferred(), handshake: deferred(), closed: deferred(), rejected: undefined };
    link.handshake.promise.catch(() => undefined);
    socket.addEventListener('open', () => link.opened.resolve());
    socket.addEventListener('error', () => link.opened.reject(new Error('socket error')));
    socket.addEventListener('message', event => this.onMessage(link, event.data));
    socket.addEventListener('close', () => {
      link.closed.resolve();
      link.opened.reject(new Error('socket closed before open'));
      link.handshake.reject(new Error('socket closed before accepted'));
    });
    return link;
  }

  /** Sends frames from `position` at the epoch's real-time schedule until the audio ends, the socket closes or the driver stops. */
  private async pump(link: Link, epoch: Epoch): Promise<Ended> {
    const { socket } = link;
    const { units } = this.state;
    while (this.position < this.end) {
      if (this.stopReason !== null) {
        socket.send(JSON.stringify({ _tag: 'stop', reason: 'close' }));
        return 'stopped';
      }
      if (socket.readyState !== WebSocket.OPEN) return 'closed';
      const due = epoch.wall_base + ((this.position - epoch.clock.sample_start) / this.rate) * 1000;
      await this.sleep(Math.max(due - Date.now(), FRAME_MS / CATCH_UP));
      while (socket.bufferedAmount > MAX_BUFFERED_BYTES && socket.readyState === WebSocket.OPEN) await delay(20);
      if (this.stopReason !== null || socket.readyState !== WebSocket.OPEN) continue;
      const count = Math.min(this.frameSamples, this.end - this.position);
      const samples = await this.readSamples(this.position, count);
      const planted = factTimes(epoch.clock, this.facts, this.position, count);
      if (Object.keys(planted).length > 0) {
        Object.assign(this.state.actual_at, planted);
        this.save();
      }
      socket.send(encodePcmFrame({ track: 0, sequence: epoch.sequence++, sample_start: this.position, sample_count: count }, samples));
      this.position += count;
      if (isSpeech(samples)) units.speech_seconds += count / this.rate;
      this.flushChunks(epoch, this.position);
    }
    socket.send(JSON.stringify({ _tag: 'stop', reason: 'close' }));
    await Promise.race([link.closed.promise, this.sleep(10_000)]);
    return 'finished';
  }

  /** One socket from `start` to close; a thrown error means it never got going. */
  private async session(epoch: Epoch): Promise<{ ended: Ended; rejected?: Rejection }> {
    const link = this.connect();
    try {
      await link.opened.promise;
      link.socket.send(JSON.stringify({ _tag: 'start', protocol_version: 1, listener_id: this.state.listener_id, epoch_id: epoch.id, track: 0, clock: epoch.clock, lease_generation: this.generation, start_reason: epoch.reason }));
      const timeout = delay(15_000, undefined, { ref: false }).then(() => Promise.reject(new Error('no accepted message in 15 s')));
      const verdict = await Promise.race([link.handshake.promise, timeout]);
      if (verdict._tag === 'rejected') return { ended: 'closed', rejected: verdict };
      this.position = verdict.resume_from_sample;
      log('accepted', { epoch_id: epoch.id, resume_from_sample: this.position, generation: this.generation });
      const ended = await this.pump(link, epoch);
      return link.rejected === undefined ? { ended } : { ended, rejected: link.rejected };
    } finally {
      link.socket.close();
    }
  }

  /** A closed epoch or a newer lease generation starts a fresh epoch from the acknowledged offset; anything else is fatal. */
  private async rotate(old: Epoch, { reason, message }: Rejection) {
    if (reason !== 'epoch_closed' && reason !== 'stale_generation') return this.stop(`rejected: ${reason}: ${message}`, 1);
    log('epoch_rotated', { reason, epoch_id: old.id });
    this.flushChunks(old, this.state.offset, true);
    this.position = this.state.offset;
    this.epoch = null;
    await this.heartbeat();
  }

  private attempt() {
    const current = (this.epoch ??= this.newEpoch());
    return this.session(current).then(
      outcome => ({ ...outcome, current }),
      error => (log('stream_failed', { error: String(error) }), { ended: 'failed' as const, current }),
    );
  }

  /** Rotates the epoch after a rejection, then waits before reconnecting; returns the next backoff. */
  private async recover(outcome: { ended: Ended | 'failed'; rejected?: Rejection; current: Epoch }, backoff: number) {
    if (outcome.rejected !== undefined) {
      await this.rotate(outcome.current, outcome.rejected);
      await this.sleep(backoff);
      return Math.min(backoff * 2, 30_000);
    }
    this.state.counters.reconnects++;
    await this.sleep(backoff);
    return outcome.ended === 'failed' ? Math.min(backoff * 2, 30_000) : 1_000;
  }

  private async streamLoop() {
    let backoff = 1_000;
    while (this.stopReason === null && this.position < this.end) {
      const outcome = await this.attempt();
      if (outcome.ended === 'finished' || outcome.ended === 'stopped') break;
      backoff = await this.recover(outcome, backoff);
    }
    if (this.epoch !== null) this.flushChunks(this.epoch, this.position, true);
  }

  // --- sharing ----------------------------------------------------------------------------------------------

  private async shareOne(id: string) {
    try {
      await this.call('POST', `/api/v1/meetings/${id}/share`, { visibility: 'workspace' });
      this.state.counters.shares++;
      log('shared', { meeting_id: id });
    } catch (error) {
      this.state.counters.share_failures++;
      log('share_failed', { meeting_id: id, error: String(error) });
    }
  }

  /** Idempotent: every restricted meeting of this listener is shared with the workspace. */
  private async shareMeetings() {
    try {
      let cursor: string | null = null;
      do {
        const query: string = `listener=${this.state.listener_id}&limit=200${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const page: { meetings: Array<{ id: string; visibility: string }>; next_cursor: string | null } = await this.call('GET', `/api/v1/meetings?${query}`);
        for (const meeting of page.meetings) if (meeting.visibility === 'restricted') await this.shareOne(meeting.id);
        cursor = page.next_cursor;
      } while (cursor !== null);
    } catch (error) {
      this.state.counters.share_failures++;
      log('share_list_failed', { error: String(error) });
    }
  }

  private async shareLoop() {
    while (this.stopReason === null) {
      await this.sleep(SHARE_MS);
      if (this.stopReason === null) await this.shareMeetings();
    }
  }

  // --- watchdog: kill switch, cost, state ---------------------------------------------------------------

  private async watchdog() {
    let last = Date.now();
    let lastSaved = 0;
    let lastStatus = 0;
    while (this.stopReason === null) {
      await this.sleep(1_000);
      const now = Date.now();
      this.state.units.run_seconds += (now - last) / 1000;
      last = now;
      const { killFile, maxUsd } = this.options;
      if (existsSync(killFile)) this.stop(`kill file ${killFile}`);
      else if (this.cost >= maxUsd) this.stop(`cost hard stop: $${this.cost.toFixed(4)} of $${maxUsd}`, 3);
      if (now - lastSaved >= 5_000) (this.save(), (lastSaved = now));
      if (now - lastStatus >= STATUS_MS) (this.status(), (lastStatus = now));
    }
  }

  private status() {
    const { rate, position } = this;
    log('status', { position_s: Math.round(position / rate), acked_s: Math.round(this.state.offset / rate), cost_usd: Number(this.cost.toFixed(4)), queue: this.queue.length, ...this.state.counters });
  }

  // --- run --------------------------------------------------------------------------------------------------

  async run() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2'] as const) process.on(signal, () => this.stop(`signal ${signal}`));
    if (this.state.listener_id === null) {
      const listener = await this.call('POST', '/api/v1/listeners', { name: this.options.name, mode: 'room', capabilities: { driver: 'soak', sample_rate: this.rate } });
      this.state.listener_id = listener.id;
    }
    this.save();
    log('started', { listener_id: this.state.listener_id, audio: this.options.manifest ?? this.options.audio, sample_rate: this.rate, audio_seconds: Math.round(this.source.samples / this.rate), from_s: Math.round(this.position / this.rate), until_s: Math.round(this.end / this.rate), max_usd: this.options.maxUsd });
    while (this.stopReason === null && !(await this.heartbeat())) await this.sleep(5_000);
    const background = [this.heartbeatLoop(), this.shareLoop(), this.watchdog()];
    const streamed = this.streamLoop();
    const uploaded = this.uploadLoop(streamed);
    await streamed;
    this.stop('end of audio');
    await Promise.all([uploaded, ...background]);
    await this.shareMeetings();
    this.save();
    await this.source.close();
    log('stopped', { reason: this.stopReason, cost_usd: Number(this.cost.toFixed(4)), ...this.state.counters });
    return this.exitCode;
  }
}

async function drive(options: DriverOptions): Promise<number> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(options.killFile)) throw new Error(`kill file ${options.killFile} exists; remove it to start`);
  const stateFile = join(options.stateDir, 'driver.json');
  const state: State = existsSync(stateFile) ? { ...freshState(), ...JSON.parse(readFileSync(stateFile, 'utf8')) } : freshState();
  const spent = costUsd(state.units, options.baselineUsd);
  if (spent >= options.maxUsd) {
    log('cost_hard_stop', { cost_usd: spent, max_usd: options.maxUsd, phase: 'before start' });
    return 3;
  }
  const manifest = options.manifest === null ? null : JSON.parse(readFileSync(options.manifest, 'utf8'));
  const source = manifest === null ? await wavSource(options.audio!) : await manifestSource(options.manifest!, manifest);
  return new SoakDriver(options, state, source, manifest?.facts ?? []).run();
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      audio: { type: 'string' },
      manifest: { type: 'string' },
      'state-dir': { type: 'string' },
      'kill-file': { type: 'string' },
      'max-usd': { type: 'string', default: '15' },
      'baseline-usd': { type: 'string', default: '0' },
      'max-seconds': { type: 'string' },
      name: { type: 'string', default: 'soak-driver' },
    },
  });
  const token = process.env['SANCTUM_SOAK_TOKEN'];
  if (!values['base-url'] || !values['state-dir'] || !token || (values.audio === undefined) === (values.manifest === undefined)) {
    throw new Error('Usage: --base-url <url> (--audio <wav> | --manifest <manifest.json>) --state-dir <dir> and SANCTUM_SOAK_TOKEN in the environment');
  }
  process.exitCode = await drive({
    baseUrl: values['base-url'],
    token,
    audio: values.audio ?? null,
    manifest: values.manifest ?? null,
    stateDir: values['state-dir'],
    killFile: values['kill-file'] ?? join(values['state-dir'], 'KILL'),
    maxUsd: parseLimit('max-usd', values['max-usd']),
    baselineUsd: parseLimit('baseline-usd', values['baseline-usd']),
    maxSeconds: values['max-seconds'] === undefined ? null : parseLimit('max-seconds', values['max-seconds']),
    name: values.name,
  }).catch(error => {
    console.error(String(error));
    return 1;
  });
}
