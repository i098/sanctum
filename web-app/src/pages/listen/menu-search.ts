/** What the Menu's search box lists and how the keys move through it; MenuSearch.tsx only renders it. */
import type { ContextItem, Meeting } from '@sanctum/sdk';
import type { Loadable } from './review-data.ts';

export interface MenuCommand {
  label: string;
  /** A rejection is shown under the box and keeps the Menu open; success closes it. */
  run: () => void | Promise<void>;
}

export interface Entry {
  key: string;
  tag: string;
  title: string;
  detail?: string;
  /** An item with no meeting has nowhere to open. */
  open?: () => void | Promise<void>;
  failure?: string;
}

export const KINDS: ReadonlyArray<ContextItem['kind']> = ['decision', 'commitment'];
export const SHOWN = 8;

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const day = (iso: string): string => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

const dataOf = <A>(loaded: Loadable<ReadonlyArray<A>>): ReadonlyArray<A> => (loaded.status === 'ok' ? loaded.data : []);

/** Meeting id to title, for labelling the meeting an item came from. */
const titlesOf = (meetings: Loadable<ReadonlyArray<Meeting>>): ReadonlyMap<string, string> =>
  new Map(dataOf(meetings).map(meeting => [meeting.id, meeting.title ?? 'Untitled meeting']));

export interface Sources {
  sections: ReadonlyArray<{ id: string; label: string }>;
  commands: ReadonlyArray<MenuCommand>;
  meetings: Loadable<ReadonlyArray<Meeting>>;
  items: Loadable<ReadonlyArray<ContextItem>>;
}

/** What choosing a row does; the caller clears the box first. */
export interface Opens {
  section: (id: string) => void;
  meeting: (id: string) => void;
}

/** Section and command rows whose title contains `lower`. */
function fixedEntries({ sections, commands }: Pick<Sources, 'sections' | 'commands'>, lower: string, opens: Opens): ReadonlyArray<Entry> {
  return [
    ...sections.map(({ id, label }): Entry => ({ key: `section-${id}`, tag: 'Section', title: `Open ${label}`, open: () => opens.section(id) })),
    ...commands.map(({ label, run }): Entry => ({ key: `command-${label}`, tag: 'Command', title: label, open: run, failure: `${label} did not finish: ` })),
  ].filter(entry => entry.title.toLowerCase().includes(lower));
}

/** The first `SHOWN` meetings whose title contains `lower`. */
function meetingEntries(meetings: ReadonlyArray<Meeting>, lower: string, opens: Opens): ReadonlyArray<Entry> {
  return meetings
    .flatMap(meeting => (meeting.title?.toLowerCase().includes(lower) ? [{ meeting, title: meeting.title }] : []))
    .slice(0, SHOWN)
    .map(({ meeting, title }) => ({ key: `meeting-${meeting.id}`, tag: 'Meeting', title, detail: day(meeting.started_at), open: () => opens.meeting(meeting.id) }));
}

/** One decision or commitment row: its text, where and when it was said, and a way into its meeting when it has one. */
function itemEntry(item: ContextItem, titles: ReadonlyMap<string, string>, opens: Opens): Entry {
  const meetingId = item.meeting_id;
  const where = meetingId === null ? [] : [titles.get(meetingId) ?? 'Meeting'];
  return {
    key: `item-${item.id}`,
    tag: item.kind === 'decision' ? 'Decision' : 'Commitment',
    title: item.text,
    detail: [...where, day(item.event_at ?? item.created_at)].join(' · '),
    ...(meetingId === null ? {} : { open: () => opens.meeting(meetingId) }),
  };
}

/** Every row for `query`, in order: sections and commands, meeting titles, decisions and commitments. Empty query: none. */
export function buildEntries(query: string, sources: Sources, opens: Opens): ReadonlyArray<Entry> {
  if (query === '') return [];
  const lower = query.toLowerCase();
  const titles = titlesOf(sources.meetings);
  return [
    ...fixedEntries(sources, lower, opens),
    ...meetingEntries(dataOf(sources.meetings), lower, opens),
    ...dataOf(sources.items).slice(0, SHOWN).map(item => itemEntry(item, titles, opens)),
  ];
}

/** One line per source that failed, so a partial list says what is missing. */
export function sourceNotes({ items, meetings }: Pick<Sources, 'items' | 'meetings'>): ReadonlyArray<string> {
  return [
    ...(items.status === 'error' ? [`Decisions and commitments unavailable: ${items.message}`] : []),
    ...(meetings.status === 'error' ? [`Meeting titles unavailable: ${meetings.message}`] : []),
  ];
}

/** True while a non-empty query still waits on either source. */
export const isSearching = (query: string, { items, meetings }: Pick<Sources, 'items' | 'meetings'>): boolean =>
  query !== '' && (items.status === 'loading' || meetings.status === 'loading');

/** The line under an empty list: still searching, no match, or nothing when a failed source already explains it. */
export function emptyMessage(count: number, query: string, searching: boolean, noteCount: number): string | null {
  if (count > 0) return null;
  if (searching) return 'Searching…';
  return noteCount === 0 ? `No match for “${query}”.` : null;
}

export type KeyAction = { kind: 'move'; active: number } | { kind: 'choose' } | { kind: 'clear' };

/** The search box's key handling: ↑ ↓ wrap through `count` rows, Enter opens, Escape clears a non-empty box. Other keys: nothing. */
export function keyAction(key: string, { active, count, text }: { active: number; count: number; text: string }): KeyAction | undefined {
  switch (key) {
    case 'ArrowDown':
      return count > 0 ? { kind: 'move', active: (active + 1) % count } : undefined;
    case 'ArrowUp':
      return count > 0 ? { kind: 'move', active: (active - 1 + count) % count } : undefined;
    case 'Enter':
      return { kind: 'choose' };
    case 'Escape':
      return text === '' ? undefined : { kind: 'clear' };
    default:
      return undefined;
  }
}
