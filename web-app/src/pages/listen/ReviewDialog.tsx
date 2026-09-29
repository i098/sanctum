import type { MeetingNotes, SanctumClient } from '@sanctum/sdk';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Dialog } from './Dialog.tsx';
import { type Frame, settle } from './review-data.ts';

const TABS = ['Notes', 'Transcript', 'Recording', 'Memory', 'Context', 'Activity'] as const;

type NotesState = { readonly status: 'loading' } | { readonly status: 'empty' } | Frame<MeetingNotes>;

/** Canonical notes of the most recent meeting this caller may read, through the same v1 SDK agents use. */
async function latestNotes(client: SanctumClient, signal: AbortSignal): Promise<NotesState> {
  const page = await settle(client.meetings.listMeetings({ limit: 1 }, { signal }));
  if (page.status === 'error') return page;
  const meeting = page.data.meetings[0];
  if (meeting === undefined) return { status: 'empty' };
  return settle(client.meetings.getNotes({ meeting_id: meeting.id }, { signal }));
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function NotesPanel({ state }: { state: NotesState }) {
  if (state.status === 'loading') return <p>Loading notes…</p>;
  if (state.status === 'empty') return <p>No meetings yet.</p>;
  if (state.status === 'error') return <p>Notes unavailable: {state.message}</p>;
  const notes = state.data;
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
                {point.text} <span className="listen-source">{point.sources.map(source => clock(source.start_ms)).join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

/** Review overlay: six tabs; Notes shows the canonical summary, the rest stay truthful about missing data. */
export function ReviewDialog({ client, open, onClose }: { client: SanctumClient; open: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState(0);
  const [notes, setNotes] = useState<NotesState>({ status: 'loading' });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setNotes({ status: 'loading' });
    void latestNotes(client, controller.signal).then(state => controller.signal.aborted || setNotes(state));
    return () => controller.abort();
  }, [client, open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (move === undefined) return;
    const next = (selected + move + TABS.length) % TABS.length;
    setSelected(next);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  };
  return (
    <Dialog title="Review" open={open} onClose={onClose}>
      <div role="tablist" aria-label="Review sections" className="listen-tabs" onKeyDown={onKeyDown}>
        {TABS.map((tab, index) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`review-tab-${index}`}
            aria-selected={index === selected}
            aria-controls="review-panel"
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelected(index)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="review-panel" aria-labelledby={`review-tab-${selected}`} className="listen-panel">
        {selected === 0 ? <NotesPanel state={notes} /> : <p>{TABS[selected]} unavailable: this listener is not connected to meeting data yet.</p>}
      </div>
    </Dialog>
  );
}
