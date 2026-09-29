import { describe, expect, it } from 'vitest';
import { createCaptureStore, initialCaptureSnapshot } from '../src/lib/capture/view.ts';

describe('createCaptureStore', () => {
  it('starts from the initial snapshot with no archive claim', () => {
    const { view } = createCaptureStore();
    expect(view.getSnapshot()).toEqual(initialCaptureSnapshot);
    expect(view.getSnapshot().archive).toBeNull();
    expect(view.getSnapshot().listener).toBe('stopped');
  });

  it('notifies subscribers when a field changes', () => {
    const store = createCaptureStore();
    let calls = 0;
    store.view.subscribe(() => calls++);
    store.update({ listener: 'starting', permission: 'pending' });
    expect(calls).toBe(1);
    expect(store.view.getSnapshot()).toMatchObject({ listener: 'starting', permission: 'pending' });
  });

  it('does not notify or replace the snapshot on an identical patch', () => {
    const store = createCaptureStore();
    store.update({ listener: 'listening', archive: 'capturing' });
    const before = store.view.getSnapshot();
    let calls = 0;
    store.view.subscribe(() => calls++);
    store.update({ listener: 'listening', archive: 'capturing' });
    store.update({});
    expect(calls).toBe(0);
    expect(store.view.getSnapshot()).toBe(before);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createCaptureStore();
    let calls = 0;
    const unsubscribe = store.view.subscribe(() => calls++);
    store.update({ bufferedChunks: 1 });
    unsubscribe();
    store.update({ bufferedChunks: 2 });
    expect(calls).toBe(1);
  });

  it('returns a stable, frozen snapshot between reads and a new one after change', () => {
    const initial = { ...initialCaptureSnapshot, wakeLock: 'unsupported' as const };
    const store = createCaptureStore(initial);
    const first = store.view.getSnapshot();
    expect(store.view.getSnapshot()).toBe(first);
    expect(first).not.toBe(initial);
    expect(Object.isFrozen(first)).toBe(true);
    store.update({ issue: 'no_input' });
    const second = store.view.getSnapshot();
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    expect(first.issue).toBeNull();
    expect(second).toMatchObject({ issue: 'no_input', wakeLock: 'unsupported' });
  });
});
