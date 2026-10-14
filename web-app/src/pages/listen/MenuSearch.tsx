/**
 * The Menu's one search box: decisions and commitments (`GET /api/v1/context/search`), meeting titles
 * from the newest meetings, and a fixed command list. There is no transcript full-text search.
 * ↑ ↓ move, Enter opens, Escape clears the box before it closes the Menu.
 */
import type { ContextItem, Meeting, SanctumClient } from '@sanctum/sdk';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react';

export interface MenuCommand {
  label: string;
  /** A rejection is shown under the box and keeps the Menu open; success closes it. */
  run: () => void | Promise<void>;
}

interface MenuSearchProps {
  client: SanctumClient;
  sections: ReadonlyArray<{ id: string; label: string }>;
  commands: ReadonlyArray<MenuCommand>;
  onSection: (id: string) => void;
  onMeeting: (id: string) => void;
  onClose: () => void;
  /** Shown while the box is empty: the rail and the active section. */
  children: ReactNode;
}

interface Entry {
  key: string;
  tag: string;
  title: string;
  detail?: string;
  /** An item with no meeting has nowhere to open. */
  open?: () => void | Promise<void>;
  failure?: string;
}

const KINDS: ReadonlyArray<ContextItem['kind']> = ['decision', 'commitment'];
const DEBOUNCE_MS = 250;
/** ponytail: matches titles among the newest 200 meetings; page the list when search must reach older ones. */
const MEETING_LIMIT = 200;
/** Most items one search returns (the server's maximum). */
const SEARCH_LIMIT = 200;
const SHOWN = 8;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Loaded<A> = { status: 'loading' } | { status: 'ok'; data: A } | { status: 'error'; message: string };
const LOADING = { status: 'loading' } as const;

const day = (iso: string): string => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

/** Meetings are read on the first query, so opening the Menu costs nothing until someone searches. */
function useMeetings(client: SanctumClient, wanted: boolean): Loaded<ReadonlyArray<Meeting>> {
  const [meetings, setMeetings] = useState<Loaded<ReadonlyArray<Meeting>>>(LOADING);
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    client.meetings.listMeetings({ limit: MEETING_LIMIT }, { signal: controller.signal }).then(
      page => setMeetings({ status: 'ok', data: page.meetings }),
      (error: unknown) => controller.signal.aborted || setMeetings({ status: 'error', message: errorText(error) }),
    );
    return () => controller.abort();
  }, [client, wanted]);
  return meetings;
}

/** Decisions and commitments matching `query`, after a short pause in typing; `query` empty reads nothing. */
function useItems(client: SanctumClient, query: string): Loaded<ReadonlyArray<ContextItem>> {
  const [items, setItems] = useState<{ query: string; result: Loaded<ReadonlyArray<ContextItem>> }>({ query: '', result: LOADING });
  useEffect(() => {
    if (query === '') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      client.context.searchContext({ q: query, limit: SEARCH_LIMIT }, { signal: controller.signal }).then(
        found => setItems({ query, result: { status: 'ok', data: found.items.filter(item => KINDS.includes(item.kind) && item.state !== 'superseded') } }),
        (error: unknown) => controller.signal.aborted || setItems({ query, result: { status: 'error', message: errorText(error) } }),
      );
    }, DEBOUNCE_MS);
    return () => (clearTimeout(timer), controller.abort());
  }, [client, query]);
  // A result for an earlier query never shows under a newer one.
  return items.query === query ? items.result : LOADING;
}

/** Touch screens keep the keyboard closed until the box is tapped; a pointer device types at once. */
const focusFirst = (input: HTMLInputElement | null): void => {
  if (input !== null && matchMedia('(pointer: fine)').matches) input.setAttribute('autofocus', '');
};

export function MenuSearch({ client, sections, commands, onSection, onMeeting, onClose, children }: MenuSearchProps) {
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const query = text.trim();
  const lower = query.toLowerCase();
  const meetings = useMeetings(client, query !== '');
  const items = useItems(client, query);
  const titles = useMemo(() => new Map(meetings.status === 'ok' ? meetings.data.map(meeting => [meeting.id, meeting.title ?? 'Untitled meeting']) : []), [meetings]);

  const entries: ReadonlyArray<Entry> = useMemo(() => {
    const clear = (): void => setText('');
    const fixed: ReadonlyArray<Entry> = [
      ...sections.map(({ id, label }) => ({ key: `section-${id}`, tag: 'Section', title: `Open ${label}`, open: () => (clear(), onSection(id)) })),
      ...commands.map(({ label, run }) => ({ key: `command-${label}`, tag: 'Command', title: label, open: run, failure: `${label} did not finish: ` })),
    ].filter(entry => entry.title.toLowerCase().includes(lower));
    const found: ReadonlyArray<Entry> = (meetings.status === 'ok' ? meetings.data : [])
      .filter(meeting => meeting.title?.toLowerCase().includes(lower))
      .slice(0, SHOWN)
      .map(meeting => ({ key: `meeting-${meeting.id}`, tag: 'Meeting', title: meeting.title!, detail: day(meeting.started_at), open: () => (clear(), onMeeting(meeting.id)) }));
    const said: ReadonlyArray<Entry> = (items.status === 'ok' ? items.data : []).slice(0, SHOWN).map(item => ({
      key: `item-${item.id}`,
      tag: item.kind === 'decision' ? 'Decision' : 'Commitment',
      title: item.text,
      detail: [item.meeting_id === null ? null : (titles.get(item.meeting_id) ?? 'Meeting'), day(item.event_at ?? item.created_at)].filter(Boolean).join(' · '),
      ...(item.meeting_id === null ? {} : { open: () => (clear(), onMeeting(item.meeting_id!)) }),
    }));
    return query === '' ? [] : [...fixed, ...found, ...said];
  }, [query, lower, sections, commands, meetings, items, titles, onSection, onMeeting]);

  // A new result list starts at its first row.
  useEffect(() => setActive(0), [entries.length, query]);
  useEffect(() => setFailure(null), [query]);

  const choose = (entry: Entry | undefined): void => {
    if (entry?.open === undefined) return;
    setFailure(null);
    // A command that rejects stays in the list with its reason; a section or meeting always succeeds.
    Promise.resolve()
      .then(entry.open)
      .then(entry.tag === 'Command' ? onClose : undefined, (error: unknown) => setFailure(`${entry.failure ?? ''}${errorText(error)}`));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move !== undefined && entries.length > 0) {
      event.preventDefault();
      setActive((active + move + entries.length) % entries.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(entries[active]);
    } else if (event.key === 'Escape' && text !== '') {
      // The first Escape clears the box; the dialog stays open.
      event.preventDefault();
      setText('');
    }
  };

  const settled = (loaded: Loaded<unknown>): boolean => loaded.status !== 'loading';
  const notes = [
    items.status === 'error' && `Decisions and commitments unavailable: ${items.message}`,
    meetings.status === 'error' && `Meeting titles unavailable: ${meetings.message}`,
  ].filter(Boolean);
  const searching = query !== '' && !(settled(items) && settled(meetings));

  return (
    <>
      <div role="search" className="listen-menu-search">
        <input
          ref={focusFirst}
          type="text"
          role="combobox"
          aria-label="Search"
          aria-expanded={query !== ''}
          aria-controls={listId}
          aria-activedescendant={entries[active] && `${listId}-${entries[active].key}`}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search meetings, decisions, commands…"
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {query === '' ? children : (
        <div className="listen-menu-results">
          <ul id={listId} role="listbox" aria-label="Search results">
            {entries.map((entry, index) => (
              <li key={entry.key} id={`${listId}-${entry.key}`} role="option" aria-selected={index === active} aria-disabled={entry.open === undefined} onClick={() => choose(entry)} onPointerMove={() => setActive(index)}>
                <span className="listen-result-tag">{entry.tag}</span>
                <span className="listen-result-title">{entry.title}</span>
                {entry.detail && <span className="listen-result-detail">{entry.detail}</span>}
              </li>
            ))}
          </ul>
          <div role="status" className="listen-result-note">
            {searching && entries.length === 0 && 'Searching…'}
            {!searching && entries.length === 0 && notes.length === 0 && `No match for “${query}”.`}
            {failure && <p role="alert">{failure}</p>}
            {notes.map(note => <p key={String(note)}>{note}</p>)}
            <p>Searches decisions, commitments, meeting titles and commands, not transcript text.</p>
          </div>
        </div>
      )}
    </>
  );
}
