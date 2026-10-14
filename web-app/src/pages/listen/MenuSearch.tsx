/**
 * The Menu's one search box: decisions and commitments (`GET /api/v1/context/search`), meeting titles
 * from the newest meetings, and a fixed command list. There is no transcript full-text search.
 * ↑ ↓ move, Enter opens, Escape clears the box before it closes the Menu.
 */
import type { ContextItem, Meeting, SanctumClient } from '@sanctum/sdk';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { buildEntries, type Entry, emptyMessage, errorText, isSearching, KINDS, keyAction, type Loaded, LOADING, type MenuCommand, sourceNotes } from './menu-search.ts';

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

const DEBOUNCE_MS = 250;
/** ponytail: matches titles among the newest 200 meetings; page the list when search must reach older ones. */
const MEETING_LIMIT = 200;
/** Most items one search returns (the server's maximum). */
const SEARCH_LIMIT = 200;

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

interface ResultsProps {
  listId: string;
  entries: ReadonlyArray<Entry>;
  active: number;
  query: string;
  searching: boolean;
  notes: ReadonlyArray<string>;
  failure: string | null;
  onChoose: (entry: Entry) => void;
  onHover: (index: number) => void;
}

function ResultRow({ id, entry, selected, onChoose, onHover }: { id: string; entry: Entry; selected: boolean; onChoose: () => void; onHover: () => void }) {
  return (
    <li id={id} role="option" aria-selected={selected} aria-disabled={entry.open === undefined} onClick={onChoose} onPointerMove={onHover}>
      <span className="listen-result-tag">{entry.tag}</span>
      <span className="listen-result-title">{entry.title}</span>
      {entry.detail && <span className="listen-result-detail">{entry.detail}</span>}
    </li>
  );
}

function Results({ listId, entries, active, query, searching, notes, failure, onChoose, onHover }: ResultsProps) {
  return (
    <div className="listen-menu-results">
      <ul id={listId} role="listbox" aria-label="Search results">
        {entries.map((entry, index) => (
          <ResultRow key={entry.key} id={`${listId}-${entry.key}`} entry={entry} selected={index === active} onChoose={() => onChoose(entry)} onHover={() => onHover(index)} />
        ))}
      </ul>
      <div role="status" className="listen-result-note">
        {emptyMessage(entries.length, query, searching, notes.length)}
        {failure && <p role="alert">{failure}</p>}
        {notes.map(note => <p key={note}>{note}</p>)}
        <p>Searches decisions, commitments, meeting titles and commands, not transcript text.</p>
      </div>
    </div>
  );
}

export function MenuSearch({ client, sections, commands, onSection, onMeeting, onClose, children }: MenuSearchProps) {
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const query = text.trim();
  const meetings = useMeetings(client, query !== '');
  const items = useItems(client, query);
  const entries = buildEntries(query, { sections, commands, meetings, items }, {
    section: id => (setText(''), onSection(id)),
    meeting: id => (setText(''), onMeeting(id)),
  });

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
    const action = keyAction(event.key, { active, count: entries.length, text });
    if (action === undefined) return;
    event.preventDefault();
    if (action.kind === 'move') setActive(action.active);
    else if (action.kind === 'choose') choose(entries[active]);
    else setText('');
  };

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
        <Results listId={listId} entries={entries} active={active} query={query} searching={isSearching(query, { items, meetings })} notes={sourceNotes({ items, meetings })} failure={failure} onChoose={choose} onHover={setActive} />
      )}
    </>
  );
}
