import { type ActionReceipt, type Meeting, pages, type SanctumClient } from '@sanctum/sdk';
import { useEffect, useState } from 'react';
import { subscribeActions } from './engine.ts';
import { collect, type Loadable, settle } from './review-data.ts';
import { show, time } from './ReviewPanels.tsx';

const RECENT = 5;

const titleCase = (slug: string): string => slug.split(/[_-]+/).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');

/** A Pipedream action key is `<app>-<action>`: `gmail-send-email` reads "Gmail · Send email". */
function actionName(key: string): string {
  const [app = '', ...action] = key.split('-');
  const name = titleCase(action.join('-')).toLowerCase();
  return action.length === 0 ? titleCase(app) : `${titleCase(app)} · ${name[0]!.toUpperCase()}${name.slice(1)}`;
}

/** The state word's tone: muted while it waits or runs, green done, amber when a person must look, red failed. */
const TONE: Record<ActionReceipt['state'], string> = {
  proposed: 'muted',
  queued: 'muted',
  running: 'muted',
  cancelled: 'muted',
  awaiting_authorization: 'warn',
  unknown: 'warn',
  succeeded: 'done',
  failed: 'failed',
};

function WorkReceipts({ actions }: { actions: ReadonlyArray<ActionReceipt> }) {
  if (actions.length === 0) return <p>No actions were requested in this meeting.</p>;
  return (
    <ul className="listen-items listen-work">
      {actions.map(action => (
        <li key={action.action_id}>
          <span className="listen-work-name">{actionName(action.action_key)}</span>{' '}
          <span className="listen-work-state" data-tone={TONE[action.state]}>{action.state.replaceAll('_', ' ')}</span>{' '}
          <span className="listen-source">
            {action.attempts} {action.attempts === 1 ? 'attempt' : 'attempts'}
            {action.reconciliation === 'pending' && ' · awaiting reconciliation'} · {time(action.updated_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

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
              {show('Activity', receipts[meeting.id] ?? { status: 'loading' }, actions => <WorkReceipts actions={actions} />)}
            </section>
          ))
        ),
      )}
    </div>
  );
}
