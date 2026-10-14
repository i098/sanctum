import type { Meeting, SanctumClient } from '@sanctum/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { settle } from './review-data.ts';
import { ReviewSection } from './ReviewSection.tsx';

const PAGE = 20;
/** Where the Menu body fits list and Review side by side; keep in step with listen.css. */
const WIDE = '(min-width: 641px)';
const isLive = ({ state }: Meeting): boolean => state === 'provisional' || state === 'active' || state === 'closing';

type Cursor = Parameters<SanctumClient['meetings']['listMeetings']>[0]['cursor'];

const startedAt = ({ started_at, timezone }: Meeting): string =>
  new Date(started_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone });

/** Newest-first pages of meetings the caller may read, appended as asked for; a failed page keeps what is already shown. */
function useMeetings(client: SanctumClient) {
  const [meetings, setMeetings] = useState<ReadonlyArray<Meeting> | null>(null);
  const [next, setNext] = useState<Cursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef(new AbortController());
  const load = useCallback(
    async (cursor: Cursor | null) => {
      const { signal } = abort.current;
      setBusy(true);
      const page = await settle(client.meetings.listMeetings({ limit: PAGE, ...(cursor ? { cursor } : {}) }, { signal }));
      if (signal.aborted) return;
      setBusy(false);
      if (page.status === 'error') return setError(page.message);
      setError(null);
      setNext(page.data.next_cursor);
      setMeetings(before => [...(before ?? []), ...page.data.meetings]);
    },
    [client],
  );
  useEffect(() => {
    abort.current = new AbortController();
    void load(null);
    return () => abort.current.abort();
  }, [load]);
  return { meetings, error, busy, more: next ? () => void load(next) : null, retry: meetings === null && error ? () => void load(null) : null };
}

function Row({ meeting, current, onSelect }: { meeting: Meeting; current: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="listen-meeting-row" aria-current={current ? 'true' : undefined} onClick={onSelect}>
      <span>{meeting.title ?? 'Untitled meeting'}</span>
      <small>
        {isLive(meeting) ? 'live · ' : ''}
        {startedAt(meeting)}
      </small>
    </button>
  );
}

function Group({ heading, rows, selected, onSelect }: { heading: string; rows: ReadonlyArray<Meeting>; selected: Meeting | null; onSelect: (meeting: Meeting) => void }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={heading}>
      <h3>{heading}</h3>
      {rows.map(meeting => (
        <Row key={meeting.id} meeting={meeting} current={meeting.id === selected?.id} onSelect={() => onSelect(meeting)} />
      ))}
    </section>
  );
}

const loadingOrNone = (meetings: ReadonlyArray<Meeting> | null, error: string | null): string | null =>
  meetings === null ? (error ? null : 'Loading meetings…') : meetings.length === 0 ? 'No meetings yet.' : null;

/** What the list cannot show: still loading, none, the API's reason for a failed page, and the way to try again. */
function Notices({ meetings, error, retry }: Pick<MeetingsState, 'meetings' | 'error' | 'retry'>) {
  const note = loadingOrNone(meetings, error);
  return (
    <>
      {note && <p>{note}</p>}
      {error && <p role="alert">Meetings unavailable: {error}</p>}
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </>
  );
}

type MeetingsState = ReturnType<typeof useMeetings>;

function Paging({ busy, more }: { busy: boolean; more: (() => void) | null }) {
  if (!more) return null;
  return (
    <button type="button" disabled={busy} onClick={more}>
      {busy ? 'Loading…' : 'Load more'}
    </button>
  );
}

function MeetingList({ state, selected, onSelect }: { state: MeetingsState; selected: Meeting | null; onSelect: (meeting: Meeting) => void }) {
  const rows = state.meetings ?? [];
  return (
    <div className="listen-meetings-list">
      <Group heading="Now" rows={rows.filter(isLive)} selected={selected} onSelect={onSelect} />
      <Group heading="Recent" rows={rows.filter(meeting => !isLive(meeting))} selected={selected} onSelect={onSelect} />
      <Notices meetings={state.meetings} error={state.error} retry={state.retry} />
      <Paging busy={state.busy} more={state.more} />
    </div>
  );
}

const newest = (meetings: ReadonlyArray<Meeting> | null): Meeting | null => meetings?.find(isLive) ?? meetings?.[0] ?? null;

/**
 * The open meeting: a search result (`meetingId`) once read, else the one chosen, else side by side the live
 * (else newest) one, as Review always did, and on a phone none, so the list shows first.
 */
function useSelection(client: SanctumClient, meetings: ReadonlyArray<Meeting> | null, meetingId: string | undefined): [Meeting | null, (meeting: Meeting | null) => void] {
  const [chosen, choose] = useState<Meeting | null | undefined>(undefined);
  useEffect(() => {
    if (meetingId === undefined) return;
    const controller = new AbortController();
    void settle(client.meetings.getMeeting({ meeting_id: meetingId }, { signal: controller.signal })).then(found => controller.signal.aborted || found.status !== 'ok' || choose(found.data));
    return () => controller.abort();
  }, [client, meetingId]);
  const fallback = window.matchMedia(WIDE).matches ? newest(meetings) : null;
  return [chosen === undefined ? fallback : chosen, choose];
}

/**
 * Every meeting this caller may read, newest first and paged, the live one on top; choosing one
 * opens its six Review tabs beside the list (over it on a phone). Opening or closing it never
 * touches capture.
 */
export function MeetingsSection({ client, meetingId }: { client: SanctumClient; meetingId?: string | undefined }) {
  const state = useMeetings(client);
  const [selected, choose] = useSelection(client, state.meetings, meetingId);
  return (
    <div className="listen-meetings" data-open={selected ? 'true' : undefined}>
      <MeetingList state={state} selected={selected} onSelect={choose} />
      {selected && (
        <div className="listen-meetings-detail">
          <button type="button" className="listen-meetings-back" onClick={() => choose(null)}>
            ‹ Meetings
          </button>
          <ReviewSection key={selected.id} client={client} meeting={selected} />
        </div>
      )}
    </div>
  );
}
