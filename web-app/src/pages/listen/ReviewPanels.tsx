import type { ActionReceipt, ArtifactSource, ContextEvent, ContextItem, ContextSnapshot, MeetingNotes, RecordingAccess, SegmentSource, TranscriptSegment } from '@sanctum/sdk';
import { useEffect, useRef, type ReactNode } from 'react';
import { type Loadable, playbackOffset, type Review } from './review-data.ts';

export const TABS = ['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity'] as const;
export type Tab = (typeof TABS)[number];

/** A requested jump into the recording; a fresh object each time, so the same offset can be replayed. */
export interface Seek {
  readonly seconds: number;
}

export interface Navigation {
  /** Transcript segment a source link pointed at. */
  readonly focus: string | null;
  readonly seek: Seek | null;
  readonly onSource: (segment_id: string) => void;
  readonly onPlay: (seconds: number) => void;
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const time = (iso: string, timeZone?: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone });
const words = (value: string) => value.replaceAll('_', ' ');

/** A source in flight says so; a missing one gives the API's own reason, and a denied read says so instead of looking empty. */
export function show<A>(tab: Tab, frame: Loadable<A>, render: (data: A) => ReactNode): ReactNode {
  if (frame.status === 'loading') return <p>Loading {tab.toLowerCase()}…</p>;
  if (frame.status === 'ok') return render(frame.data);
  return <p>{frame.code === 'forbidden' ? `${tab} not permitted: ${frame.message}` : `${tab} unavailable: ${frame.message}`}</p>;
}

function Sources({ sources, onSource }: { sources: ReadonlyArray<SegmentSource | ArtifactSource>; onSource: (segment_id: string) => void }) {
  return (
    <span className="listen-source">
      {sources.map(source =>
        'segment_id' in source ? (
          <button key={source.segment_id} type="button" aria-label={`Show transcript at ${clock(source.start_ms)}`} onClick={() => onSource(source.segment_id)}>
            {clock(source.start_ms)}
          </button>
        ) : (
          <span key={source.artifact_id}>external source</span>
        ),
      )}
    </span>
  );
}

function NotesPanel({ notes, onSource }: { notes: MeetingNotes; onSource: (segment_id: string) => void }) {
  return (
    <article className="listen-notes">
      <h3>{notes.title}</h3>
      <p>{notes.summary}</p>
      {notes.sections.map(section => (
        <section key={section.heading}>
          <h4>{section.heading}</h4>
          <ul>
            {section.points.map(point => (
              <li key={point.text}>
                {point.text} <Sources sources={point.sources} onSource={onSource} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

/** Play from the segment's first saved sample; says so when none was saved, and waits for the recording otherwise. */
function PlayFrom({ segment, recording, onPlay }: { segment: TranscriptSegment; recording: Loadable<RecordingAccess>; onPlay: (seconds: number) => void }) {
  if (recording.status !== 'ok') return null;
  const offset = playbackOffset(recording.data, segment.source);
  if (offset === null) return <span className="listen-source">no saved audio</span>;
  return (
    <button type="button" aria-label={`Play from ${clock(offset * 1000)}`} onClick={() => onPlay(offset)}>
      Play
    </button>
  );
}

interface TranscriptProps {
  segments: ReadonlyArray<TranscriptSegment>;
  recording: Loadable<RecordingAccess>;
  navigation: Navigation;
}

function TranscriptPanel({ segments, recording, navigation: { focus, onPlay } }: TranscriptProps) {
  useEffect(() => {
    const row = focus === null ? null : document.getElementById(`segment-${focus}`);
    row?.scrollIntoView({ block: 'center' });
    row?.focus();
  }, [focus]);
  if (segments.length === 0) return <p>No transcript yet.</p>;
  const missing = focus !== null && !segments.some(segment => segment.id === focus);
  return (
    <>
      {missing && <p>That source is not in the current transcript.</p>}
      <ol className="listen-transcript">
        {segments.map(segment => (
          <li key={segment.id} id={`segment-${segment.id}`} tabIndex={-1} aria-current={segment.id === focus || undefined}>
            <span className="listen-source">{segment.speaker_label ?? 'Unattributed'}</span> {segment.text}
            {segment.status === 'partial' && ' (partial)'} <PlayFrom segment={segment} recording={recording} onPlay={onPlay} />
          </li>
        ))}
      </ol>
    </>
  );
}

function RecordingPanel({ recording, seek }: { recording: RecordingAccess; seek: Seek | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = audio.current;
    if (element === null || seek === null) return;
    element.currentTime = seek.seconds;
    element.focus();
    // Explicit playback the user just asked for; a load failure is reported by the element's error state.
    void element.play().catch(() => undefined);
  }, [seek]);
  const gaps = recording.gaps.length;
  return (
    <div className="listen-recording">
      <audio ref={audio} controls preload="metadata" src={recording.url} aria-label="Meeting recording" />
      <p>Playback link expires at {time(recording.expires_at)}; reopen Review for a new one.</p>
      {gaps > 0 && <p>{gaps === 1 ? 'One part of this meeting has no saved audio; playback skips it.' : `${gaps} parts of this meeting have no saved audio; playback skips them.`}</p>}
    </div>
  );
}

function Items({ items, empty, onSource }: { items: ReadonlyArray<ContextItem>; empty: string; onSource: (segment_id: string) => void }) {
  if (items.length === 0) return <p>{empty}</p>;
  return (
    <ul className="listen-items">
      {items.map(item => (
        <li key={item.id}>
          <span className="listen-source">{words(item.kind)}</span> {item.text}{' '}
          <span className="listen-source">
            {item.state} · {words(item.derivation)} · revision {item.revision}
          </span>{' '}
          <Sources sources={item.sources} onSource={onSource} />
        </li>
      ))}
    </ul>
  );
}

function ContextPanel({ snapshot, onSource }: { snapshot: ContextSnapshot; onSource: (segment_id: string) => void }) {
  return (
    <>
      <p className="listen-source">
        Context revision {snapshot.revision} as of {time(snapshot.as_of, snapshot.timezone)} ({snapshot.timezone})
      </p>
      <Items items={snapshot.items} empty="No context items yet." onSource={onSource} />
      {snapshot.truncated && <p>More items exist than one snapshot returns.</p>}
    </>
  );
}

function Receipts({ actions }: { actions: ReadonlyArray<ActionReceipt> }) {
  if (actions.length === 0) return <p>No actions were requested in this meeting.</p>;
  return (
    <ul className="listen-items">
      {actions.map(action => (
        <li key={action.action_id}>
          {action.action_key} <span className="listen-source">{words(action.state)}</span>{' '}
          <span className="listen-source">
            {action.attempts} {action.attempts === 1 ? 'attempt' : 'attempts'}
            {action.reconciliation === 'pending' && ' · awaiting reconciliation'} · {time(action.updated_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Changes({ events, items }: { events: ReadonlyArray<ContextEvent>; items: ReadonlyArray<ContextItem> }) {
  if (events.length === 0) return <p>No context changes yet.</p>;
  const text = new Map(items.map(item => [item.id, item.text]));
  return (
    <ul className="listen-items">
      {events.map(event => (
        <li key={event.seq}>
          <span className="listen-source">{words(event.change)}</span> {event.item === null ? '' : `${text.get(event.item.id) ?? 'item'} (revision ${event.item.revision})`}{' '}
          <span className="listen-source">{time(event.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function ActivityPanel({ review }: { review: Review }) {
  const items = review.context.status === 'ok' ? review.context.data.items : [];
  return (
    <>
      <h3>Actions</h3>
      {show('Activity', review.actions, actions => <Receipts actions={actions} />)}
      <h3>Context changes</h3>
      {show('Activity', review.changes, events => <Changes events={events} items={items} />)}
    </>
  );
}

const PANELS: Record<Tab, (review: Review, navigation: Navigation) => ReactNode> = {
  Notes: (review, { onSource }) => show('Notes', review.notes, notes => <NotesPanel notes={notes} onSource={onSource} />),
  Transcript: (review, navigation) =>
    show('Transcript', review.transcript, segments => <TranscriptPanel segments={segments} recording={review.recording} navigation={navigation} />),
  Recording: (review, { seek }) => show('Recording', review.recording, recording => <RecordingPanel recording={recording} seek={seek} />),
  Memory: (review, { onSource }) =>
    show('Memory', review.context, snapshot => (
      <Items items={snapshot.items.filter(item => item.state === 'committed')} empty="No committed memory yet." onSource={onSource} />
    )),
  Context: (review, { onSource }) => show('Context', review.context, snapshot => <ContextPanel snapshot={snapshot} onSource={onSource} />),
  Activity: review => <ActivityPanel review={review} />,
};

/** One Review tab over the loaded meeting. */
export function ReviewPanel({ tab, review, navigation }: { tab: Tab; review: Review; navigation: Navigation }) {
  return PANELS[tab](review, navigation);
}
