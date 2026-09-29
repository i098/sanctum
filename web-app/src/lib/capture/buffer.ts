/**
 * IndexedDB recovery buffer (plan 05): pending parts and sealed chunks stay here until their
 * remote receipt is journaled in the same transaction that deletes the audio. Capacity is the
 * smaller of an application cap and the browser's reported free quota; persistence is only
 * requested where supported. An IndexedDB commit is not an fsync, and clearing or eviction
 * surfaces through `onLost` rather than being hidden.
 */
import type { RecordingChunkManifest, RecordingChunkReceipt, StartMessage } from '@sanctum/contracts';
import { groupRecordings } from './orphans.ts';
import { sealChunk, StorageError, type ChunkStore, type PartRecord, type SealedChunk } from './recorder.ts';
import type { OrphanedRecording } from './view.ts';

const DB_NAME = 'sanctum-capture';
const PARTS = 'parts';
const CHUNKS = 'chunks';
const RECEIPTS = 'receipts';
/** Each epoch's `start`, kept until a chunk of it is saved, so an epoch the server never learned can be registered later. */
const EPOCHS = 'epochs';
/** Journaled receipts kept after their audio is deleted. */
const RECEIPT_LIMIT = 1_000;
/** Default application cap on buffered audio: about 58 hours of 48 kHz PCM16. */
export const DEFAULT_CAP_BYTES = 2 ** 34;

export type EpochEnd = NonNullable<(typeof StartMessage.Type)['end_reason']>;

interface ChunkRecord extends SealedChunk {
  readonly chunk_id: string;
  /** Listener id, set once the server refused the chunk; indexed so counts never load audio. */
  readonly refused?: string;
}

interface ReceiptRecord {
  readonly chunk_id: string;
  readonly receipt: RecordingChunkReceipt;
  readonly saved_through_ms: number;
}

export interface BufferOptions {
  readonly capBytes?: number;
  readonly idb?: IDBFactory;
  readonly storage?: StorageManager | undefined;
}

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const complete = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });

const storageError = (error: unknown) =>
  error instanceof StorageError ? error : new StorageError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'full' : 'unavailable', error);

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw storageError(error);
  }
}

function upgrade(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    db.createObjectStore(PARTS, { keyPath: ['chunk_id', 'part_start'] }).createIndex('bytes', 'byte_length');
    const chunks = db.createObjectStore(CHUNKS, { keyPath: 'chunk_id' });
    chunks.createIndex('listener', ['manifest.listener_id', 'manifest.captured_at']);
    chunks.createIndex('bytes', 'manifest.byte_length');
    db.createObjectStore(RECEIPTS, { keyPath: 'chunk_id' }).createIndex('saved', 'saved_through_ms');
  }
  if (oldVersion < 2) tx.objectStore(CHUNKS).createIndex('refused', 'refused');
  if (oldVersion < 3) db.createObjectStore(EPOCHS, { keyPath: 'epoch_id' });
}

/** Every key of one listener in the `listener` index ([listener_id, captured_at]). */
const listenerRange = (listenerId: string) => IDBKeyRange.bound([listenerId, ''], [listenerId, '\uffff']);

/** Walks a cursor until `visit` returns a value (resolved) or the cursor ends (null). */
function walk<C extends IDBCursor, T>(cursor: IDBRequest<C | null>, visit: (current: C) => T | undefined): Promise<T | null> {
  return new Promise((resolve, reject) => {
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (current === null) return resolve(null);
      const found = visit(current);
      if (found === undefined) current.continue();
      else resolve(found);
    };
  });
}

/** Sums an index whose keys are byte lengths without loading the audio values. */
async function sumKeys(index: IDBIndex, each: (bytes: number, primaryKey: IDBValidKey) => void): Promise<void> {
  await walk(index.openKeyCursor(), (current) => void each(current.key as number, current.primaryKey));
}

export class RecoveryBuffer implements ChunkStore {
  private readonly db: IDBDatabase;
  private readonly capBytes: number;
  private readonly storage: StorageManager | undefined;
  private readonly partBytes = new Map<string, number>();
  private bytes = 0;
  private browserFree = Number.POSITIVE_INFINITY;
  /** Called when the browser closes the database, e.g. site data cleared or evicted. */
  onLost: () => void = () => { };

  private constructor(db: IDBDatabase, capBytes: number, storage: StorageManager | undefined) {
    this.db = db;
    this.capBytes = capBytes;
    this.storage = storage;
    db.onclose = () => this.onLost();
  }

  static open({ capBytes = DEFAULT_CAP_BYTES, idb = globalThis.indexedDB, storage = globalThis.navigator?.storage }: BufferOptions = {}): Promise<RecoveryBuffer> {
    return guarded(async () => {
      if (idb === undefined) throw new StorageError('unavailable');
      const opening = idb.open(DB_NAME, 3);
      opening.onupgradeneeded = (event) => upgrade(opening.result, event.oldVersion, opening.transaction!);
      const buffer = new RecoveryBuffer(await request(opening), capBytes, storage);
      await buffer.measure();
      return buffer;
    });
  }

  /** Asks for persistent storage where supported; `null` when the browser has no such request. */
  async persist(): Promise<boolean | null> {
    return this.storage?.persist === undefined ? null : this.storage.persist().catch(() => false);
  }

  get freeBytes(): number {
    return Math.max(0, Math.min(this.capBytes - this.bytes, this.browserFree));
  }

  appendPart(part: PartRecord): Promise<void> {
    return guarded(async () => {
      if (part.byte_length > this.freeBytes) throw new StorageError('full');
      const tx = this.db.transaction(PARTS, 'readwrite');
      tx.objectStore(PARTS).put(part);
      await complete(tx);
      this.bytes += part.byte_length;
      this.browserFree -= part.byte_length;
      this.partBytes.set(part.chunk_id, (this.partBytes.get(part.chunk_id) ?? 0) + part.byte_length);
    });
  }

  sealChunk(chunk: SealedChunk): Promise<void> {
    return guarded(async () => {
      const id = chunk.manifest.chunk_id;
      const tx = this.db.transaction([PARTS, CHUNKS], 'readwrite');
      tx.objectStore(PARTS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      tx.objectStore(CHUNKS).put({ chunk_id: id, ...chunk } satisfies ChunkRecord);
      await complete(tx);
      this.bytes += chunk.wav.byteLength - (this.partBytes.get(id) ?? 0);
      this.partBytes.delete(id);
      await this.estimate();
    });
  }

  saveEpoch(start: typeof StartMessage.Type): Promise<void> {
    return guarded(async () => {
      const tx = this.db.transaction(EPOCHS, 'readwrite');
      tx.objectStore(EPOCHS).put(start);
      await complete(tx);
    });
  }

  /** Journals why an epoch ended on this device, for its archive registration; a no-op once a chunk of it was saved. */
  endEpoch(epochId: string, reason: EpochEnd): Promise<void> {
    return guarded(async () => {
      const tx = this.db.transaction(EPOCHS, 'readwrite');
      const epochs = tx.objectStore(EPOCHS);
      const start = (await request(epochs.get(epochId))) as typeof StartMessage.Type | undefined;
      if (start !== undefined) epochs.put({ ...start, end_reason: reason });
      await complete(tx);
    });
  }

  epochStart(epochId: string): Promise<typeof StartMessage.Type | null> {
    return guarded(async () => ((await request(this.db.transaction(EPOCHS).objectStore(EPOCHS).get(epochId))) as typeof StartMessage.Type | undefined) ?? null);
  }

  /** End of the audio buffered for `epochId`, so an archive registration can say where the epoch stops. */
  epochSampleEnd(listenerId: string, epochId: string): Promise<number | null> {
    return guarded(async () => {
      let end: number | null = null;
      const range = IDBKeyRange.bound([listenerId, ''], [listenerId, '\uffff']);
      await walk(this.db.transaction(CHUNKS).objectStore(CHUNKS).index('listener').openCursor(range), (current) => {
        const { manifest } = current.value as ChunkRecord;
        if (manifest.epoch_id === epochId) end = Math.max(end ?? 0, manifest.sample_start + manifest.sample_count);
        return undefined;
      });
      return end;
    });
  }

  /** Oldest unacknowledged chunk of `listenerId` that the server has not refused. */
  nextPending(listenerId: string): Promise<SealedChunk | null> {
    return guarded(() => {
      const cursor = this.db.transaction(CHUNKS).objectStore(CHUNKS).index('listener').openCursor(listenerRange(listenerId));
      return walk(cursor, (current) => {
        const record = current.value as ChunkRecord;
        return record.refused !== undefined ? undefined : { manifest: record.manifest, wav: record.wav };
      });
    });
  }

  /** Keeps a chunk the server refused (hash conflict, unknown epoch or listener), but never offers it for upload again. */
  markRefused(chunkId: string): Promise<void> {
    return guarded(async () => {
      const tx = this.db.transaction(CHUNKS, 'readwrite');
      const chunks = tx.objectStore(CHUNKS);
      const record = (await request(chunks.get(chunkId))) as ChunkRecord | undefined;
      if (record !== undefined) chunks.put({ ...record, refused: record.manifest.listener_id } satisfies ChunkRecord);
      await complete(tx);
    });
  }

  /**
   * Chunks still owed to `listenerId`, and stranded chunks that can no longer be uploaded: sealed
   * under any other listener id (the server no longer knows it) or refused by the server. Their
   * audio is kept, never deleted here.
   */
  countChunks(listenerId: string | null): Promise<{ pending: number; stranded: number }> {
    return guarded(async () => {
      const counts = { pending: 0, stranded: 0 };
      const chunks = this.db.transaction(CHUNKS).objectStore(CHUNKS);
      await walk(chunks.index('listener').openKeyCursor(), (current) => void ((current.key as [string, string])[0] === listenerId ? counts.pending++ : counts.stranded++));
      if (listenerId !== null) await walk(chunks.index('refused').openKeyCursor(IDBKeyRange.only(listenerId)), () => void (counts.pending--, counts.stranded++));
      return counts;
    });
  }

  /** Chunks of listeners outside `owned`, grouped per recording; audio values are visited, not kept. */
  orphanedRecordings(owned: readonly string[]): Promise<OrphanedRecording[]> {
    return guarded(async () => {
      const manifests: RecordingChunkManifest[] = [];
      await walk(this.db.transaction(CHUNKS).objectStore(CHUNKS).openCursor(), (current) => {
        const { manifest } = current.value as ChunkRecord;
        if (!owned.includes(manifest.listener_id)) manifests.push(manifest);
      });
      return groupRecordings(manifests);
    });
  }

  /** Every stored chunk of one recording (listener and capture epoch), for a local export. */
  recordingChunks(listenerId: string, epochId: string): Promise<SealedChunk[]> {
    return guarded(async () => {
      const records = (await request(this.db.transaction(CHUNKS).objectStore(CHUNKS).index('listener').getAll(listenerRange(listenerId)))) as ChunkRecord[];
      return records.filter((record) => record.manifest.epoch_id === epochId);
    });
  }

  /**
   * Deletes one orphaned recording's chunks, only on a person's explicit request. Chunks of `owned`
   * listeners (pending or still being recorded) and journaled receipts are never touched.
   */
  discardRecording(listenerId: string, epochId: string, owned: readonly string[]): Promise<void> {
    return guarded(async () => {
      if (owned.includes(listenerId)) return;
      const tx = this.db.transaction(CHUNKS, 'readwrite');
      let freed = 0;
      await walk(tx.objectStore(CHUNKS).index('listener').openCursor(listenerRange(listenerId)), (current) => {
        const { manifest } = current.value as ChunkRecord;
        if (manifest.epoch_id !== epochId) return;
        current.delete();
        freed += manifest.byte_length;
      });
      await complete(tx);
      this.bytes -= freed;
    });
  }

  /** Journals the receipt and deletes the local audio in one transaction; the saved chunk proves the server knows its epoch. */
  acknowledge(manifest: RecordingChunkManifest, receipt: RecordingChunkReceipt): Promise<void> {
    return guarded(async () => {
      const tx = this.db.transaction([CHUNKS, RECEIPTS, EPOCHS], 'readwrite');
      const saved_through_ms = Date.parse(manifest.captured_at) + (manifest.sample_count / manifest.sample_rate) * 1000;
      tx.objectStore(RECEIPTS).put({ chunk_id: receipt.chunk_id, receipt, saved_through_ms } satisfies ReceiptRecord);
      tx.objectStore(CHUNKS).delete(manifest.chunk_id);
      tx.objectStore(EPOCHS).delete(manifest.epoch_id);
      const receipts = tx.objectStore(RECEIPTS);
      const excess = (await request(receipts.count())) - RECEIPT_LIMIT;
      if (excess > 0) for (const key of await request(receipts.index('saved').getAllKeys(null, excess))) receipts.delete(key);
      await complete(tx);
      this.bytes -= manifest.byte_length;
    });
  }

  /** Latest remotely confirmed audio end (wall-clock ms), or null before the first receipt. */
  savedThroughMs(): Promise<number | null> {
    return guarded(async () => {
      const newest = await request(this.db.transaction(RECEIPTS).objectStore(RECEIPTS).index('saved').openCursor(null, 'prev'));
      return newest === null ? null : (newest.value as ReceiptRecord).saved_through_ms;
    });
  }

  /** Seals parts left by a closed or crashed page into chunks; returns how many were recovered. */
  recoverOrphans(): Promise<number> {
    return guarded(async () => {
      this.partBytes.clear();
      this.bytes = 0;
      await this.measure();
      const ids = [...this.partBytes.keys()];
      for (const id of ids) {
        const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
        const parts = (await request(this.db.transaction(PARTS).objectStore(PARTS).getAll(range))) as PartRecord[];
        const samples = new Int16Array(parts.reduce((sum, part) => sum + part.samples.length, 0));
        parts.reduce((offset, part) => (samples.set(part.samples, offset), offset + part.samples.length), 0);
        await this.sealChunk(await sealChunk(parts[0]!, samples));
      }
      return ids.length;
    });
  }

  close(): void {
    this.db.onclose = null;
    this.db.close();
  }

  private async measure(): Promise<void> {
    const tx = this.db.transaction([PARTS, CHUNKS]);
    await sumKeys(tx.objectStore(PARTS).index('bytes'), (bytes, key) => {
      const id = (key as [string, number])[0];
      this.partBytes.set(id, (this.partBytes.get(id) ?? 0) + bytes);
      this.bytes += bytes;
    });
    await sumKeys(tx.objectStore(CHUNKS).index('bytes'), (bytes) => void (this.bytes += bytes));
    await this.estimate();
  }

  private async estimate(): Promise<void> {
    if (this.storage?.estimate === undefined) return;
    const { quota, usage } = await this.storage.estimate();
    if (quota !== undefined && usage !== undefined) this.browserFree = quota - usage;
  }
}
