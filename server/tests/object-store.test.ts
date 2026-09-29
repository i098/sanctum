import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { ObjectStore } from '../src/providers/object-store.ts';
import { memoryObjectStore } from './support/object-store.ts';

const hash = 'cd'.repeat(32);
const body = new Uint8Array([1, 2, 3]);

describe('memory object store (R2 test double)', () => {
  it.effect('stores copies and reports metadata', () => {
    const fake = memoryObjectStore();
    return Effect.gen(function* () {
      const store = yield* ObjectStore;
      expect(yield* store.put('a/1.wav', body, { sha256: hash, contentType: 'audio/wav' })).toEqual({ key: 'a/1.wav', byte_length: 3, sha256: hash });
      body[0] = 9;
      expect(Array.from(yield* store.get('a/1.wav'))).toEqual([1, 2, 3]);
      expect(yield* store.head('missing')).toBeNull();
      expect((yield* Effect.flip(store.get('missing'))).message).toBe('not found');
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect('injects clean and ambiguous failures once', () => {
    const fake = memoryObjectStore();
    return Effect.gen(function* () {
      const store = yield* ObjectStore;
      fake.failNext('put');
      expect((yield* Effect.flip(store.put('k', body, { sha256: hash, contentType: 'audio/wav' }))).ambiguous).toBe(false);
      expect(fake.objects.has('k')).toBe(false);
      fake.failNext('put', { ambiguous: true });
      expect((yield* Effect.flip(store.put('k', body, { sha256: hash, contentType: 'audio/wav' }))).ambiguous).toBe(true);
      expect(yield* store.head('k')).toMatchObject({ sha256: hash });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect('signs URLs that stop verifying after their TTL', () => {
    const fake = memoryObjectStore();
    let now = 1_000;
    fake.now = () => now;
    return Effect.gen(function* () {
      const url = yield* (yield* ObjectStore).presignGet('meeting/r 1.wav', 300_000);
      expect(fake.verifySignedUrl(url)).toBe('meeting/r 1.wav');
      now += 300_000;
      expect(fake.verifySignedUrl(url)).toBeNull();
    }).pipe(Effect.provide(fake.layer));
  });
});
