import type { ContextItem, Meeting } from '@sanctum/sdk';
import { describe, expect, it, vi } from 'vitest';
import { buildEntries, emptyMessage, isSearching, keyAction, type Loaded, LOADING, SHOWN, sourceNotes, type Sources } from '../src/pages/listen/menu-search.ts';

const meeting = (id: string, title: string | null): Meeting => ({
  id,
  workspace_id: 'w1',
  state: 'closed',
  title,
  started_at: '2026-09-29T09:00:00Z',
  ended_at: null,
  timezone: 'UTC',
  boundary_revision: 1,
  visibility: 'workspace',
  processing: { transcript: 'complete', notes: 'complete', memory: 'complete', recording: 'complete' },
});

const item = (id: string, over: Partial<ContextItem> = {}): ContextItem =>
  ({ id, kind: 'decision', text: `Text ${id}`, meeting_id: null, event_at: null, created_at: '2026-09-28T09:00:00Z', ...over }) as ContextItem;

const ok = <A>(data: A): Loaded<A> => ({ status: 'ok', data });

const sources = (over: Partial<Sources> = {}): Sources => ({
  sections: [{ id: 'review', label: 'Review' }, { id: 'settings', label: 'Settings' }],
  commands: [{ label: 'Fullscreen', run: () => undefined }],
  meetings: ok([]),
  items: ok([]),
  ...over,
});

const opens = () => ({ section: vi.fn(), meeting: vi.fn() });

describe('buildEntries', () => {
  it('lists nothing for an empty query', () => {
    expect(buildEntries('', sources({ meetings: ok([meeting('m1', 'Pilot')]) }), opens())).toEqual([]);
  });

  it('orders sections and commands, then meeting titles, then items, and matches case-insensitively', () => {
    const found = buildEntries('SET', sources({ meetings: ok([meeting('m1', 'Offset review'), meeting('m2', 'Pilot')]), items: ok([item('i1', { text: 'Set the price' })]) }), opens());
    expect(found.map(entry => [entry.tag, entry.title])).toEqual([
      ['Section', 'Open Settings'],
      ['Meeting', 'Offset review'],
      ['Decision', 'Set the price'],
    ]);
  });

  it('opens a section or meeting through the given handlers', () => {
    const go = opens();
    const [section, found] = buildEntries('review', sources({ meetings: ok([meeting('m1', 'Pilot review')]) }), go);
    section!.open!();
    found!.open!();
    expect(go.section).toHaveBeenCalledWith('review');
    expect(go.meeting).toHaveBeenCalledWith('m1');
  });

  it('keeps a command as its own row with the reason prefix a rejection will show', () => {
    const [command] = buildEntries('full', sources(), opens());
    expect(command).toMatchObject({ tag: 'Command', title: 'Fullscreen', failure: 'Fullscreen did not finish: ' });
  });

  it('skips untitled meetings and caps meetings and items at SHOWN', () => {
    const meetings = [meeting('u', null), ...Array.from({ length: SHOWN + 3 }, (_, n) => meeting(`m${n}`, `Pilot ${n}`))];
    const items = Array.from({ length: SHOWN + 3 }, (_, n) => item(`i${n}`, { text: `Pilot decision ${n}` }));
    const found = buildEntries('pilot', sources({ meetings: ok(meetings), items: ok(items) }), opens());
    expect(found.filter(entry => entry.tag === 'Meeting')).toHaveLength(SHOWN);
    expect(found.filter(entry => entry.tag === 'Decision')).toHaveLength(SHOWN);
  });

  it('labels an item with its meeting title, "Meeting" when the title is unknown, and opens only items that have a meeting', () => {
    const items = [
      item('i1', { meeting_id: 'm1', kind: 'commitment', event_at: '2026-09-27T09:00:00Z' }),
      item('i2', { meeting_id: 'gone' }),
      item('i3'),
    ];
    const [known, unknown, loose] = buildEntries('text', sources({ meetings: ok([meeting('m1', 'Pilot review')]), items: ok(items) }), opens());
    expect(known).toMatchObject({ tag: 'Commitment' });
    expect(known!.detail).toMatch(/^Pilot review · /);
    expect(unknown!.detail).toMatch(/^Meeting · /);
    expect(loose!.open).toBeUndefined();
    expect(loose!.detail).not.toContain('·');
  });

  it('uses a placeholder title for a meeting without one when it labels an item', () => {
    const [found] = buildEntries('text', sources({ meetings: ok([meeting('m1', null)]), items: ok([item('i1', { meeting_id: 'm1' })]) }), opens());
    expect(found!.detail).toMatch(/^Untitled meeting · /);
  });

  it('shows the fixed rows while a source is loading or has failed', () => {
    const failed: Loaded<never> = { status: 'error', message: 'offline' };
    expect(buildEntries('open', sources({ meetings: LOADING, items: failed }), opens()).map(entry => entry.tag)).toEqual(['Section', 'Section']);
  });
});

describe('sourceNotes and isSearching', () => {
  it('names each failed source', () => {
    const failed = (message: string) => ({ status: 'error', message }) as const;
    expect(sourceNotes({ items: failed('a'), meetings: failed('b') })).toEqual(['Decisions and commitments unavailable: a', 'Meeting titles unavailable: b']);
    expect(sourceNotes({ items: ok([]), meetings: ok([]) })).toEqual([]);
  });

  it('searches only while a non-empty query waits on a source', () => {
    expect(isSearching('', { items: LOADING, meetings: LOADING })).toBe(false);
    expect(isSearching('x', { items: ok([]), meetings: LOADING })).toBe(true);
    expect(isSearching('x', { items: ok([]), meetings: { status: 'error', message: 'no' } })).toBe(false);
  });
});

describe('keyAction', () => {
  const at = (active: number, count = 3, text = 'q') => ({ active, count, text });

  it('moves down and up, wrapping at both ends', () => {
    expect(keyAction('ArrowDown', at(1))).toEqual({ kind: 'move', active: 2 });
    expect(keyAction('ArrowDown', at(2))).toEqual({ kind: 'move', active: 0 });
    expect(keyAction('ArrowUp', at(1))).toEqual({ kind: 'move', active: 0 });
    expect(keyAction('ArrowUp', at(0))).toEqual({ kind: 'move', active: 2 });
  });

  it('leaves arrows alone when there are no rows', () => {
    expect(keyAction('ArrowDown', at(0, 0))).toBeUndefined();
    expect(keyAction('ArrowUp', at(0, 0))).toBeUndefined();
  });

  it('chooses on Enter, and clears on Escape only when the box has text', () => {
    expect(keyAction('Enter', at(0))).toEqual({ kind: 'choose' });
    expect(keyAction('Escape', at(0))).toEqual({ kind: 'clear' });
    expect(keyAction('Escape', at(0, 0, ''))).toBeUndefined();
  });

  it('ignores every other key, including names that exist on every object', () => {
    expect(keyAction('a', at(0))).toBeUndefined();
    expect(keyAction('constructor', at(0))).toBeUndefined();
  });
});

describe('emptyMessage', () => {
  it('says what an empty list means', () => {
    expect(emptyMessage(2, 'q', false, 0)).toBeNull();
    expect(emptyMessage(0, 'q', true, 0)).toBe('Searching…');
    expect(emptyMessage(0, 'pilot', false, 0)).toBe('No match for “pilot”.');
    expect(emptyMessage(0, 'pilot', false, 1)).toBeNull();
  });
});
