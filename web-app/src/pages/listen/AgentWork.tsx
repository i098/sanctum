import { type ActionReceipt, type Meeting, pages, type SanctumClient } from '@sanctum/sdk';
import { useEffect, useState } from 'react';
import { subscribeActions } from './engine.ts';
import { collect, type Loadable, settle } from './review-data.ts';
import { Receipts, show } from './ReviewPanels.tsx';

const RECENT = 5;

/**
 * Agent work: the receipts of the most recent meetings, read through the per-meeting actions endpoint.
 * The live stream's `action_update` names the meeting that changed, and only that meeting is read again.
 */
export function AgentWork({ client }: { client: SanctumClient }) {
  const [meetings, setMeetings] = useState<Loadable<ReadonlyArray<Meeting>>>({ status: 'loading' });
  const [receipts, setReceipts] = useState<Readonly<Record<string, Loadable<ReadonlyArray<ActionReceipt>>>>>({});
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const known = new Set<string>();
    // The newest read of a meeting wins, so a slow older read never overwrites it.
    const reads = new Map<string, number>();
    const read = (meeting_id: string): void => {
      const mine = (reads.get(meeting_id) ?? 0) + 1;
      reads.set(meeting_id, mine);
      void settle(collect(pages(client, 'actions.listMeetingActions', { meeting_id, limit: 200 }, options), next => next.actions)).then(
        frame => controller.signal.aborted || reads.get(meeting_id) !== mine || setReceipts(all => ({ ...all, [meeting_id]: frame })),
      );
    };
    const load = (): void => {
      void settle(client.meetings.listMeetings({ limit: RECENT }, options).then(page => page.meetings)).then(frame => {
        if (controller.signal.aborted) return;
        setMeetings(frame);
        if (frame.status !== 'ok') return;
        known.clear();
        for (const { id } of frame.data) {
          known.add(id);
          read(id);
        }
      });
    };
    load();
    const stop = subscribeActions(({ meeting_id }) => {
      if (meeting_id === null) return;
      if (known.has(meeting_id)) read(meeting_id);
      else load();
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [client]);
  return (
    <div className="listen-panel">
      {show('Activity', meetings, list =>
        list.length === 0 ? (
          <p>No meetings yet.</p>
        ) : (
          list.map(meeting => (
            <section key={meeting.id} aria-label={meeting.title ?? 'Untitled meeting'}>
              <h3>
                {meeting.title ?? 'Untitled meeting'}{' '}
                <span className="listen-source">
                  {meeting.state} · {new Date(meeting.started_at).toLocaleString([], { timeZone: meeting.timezone })}
                </span>
              </h3>
              {show('Activity', receipts[meeting.id] ?? { status: 'loading' }, actions => <Receipts actions={actions} />)}
            </section>
          ))
        ),
      )}
    </div>
  );
}
